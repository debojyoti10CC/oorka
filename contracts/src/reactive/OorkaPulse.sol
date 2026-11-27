// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IReactiveSystem} from "./OorkaReactive.sol";

/// @title OorkaPulse
/// @notice Event-driven half of Oorka's automation. Where OorkaReactive wakes up on a CRON timer, OorkaPulse
/// listens to the pool itself and reacts within seconds:
///
///   1. Settle on time. It mirrors the hook's epoch clock (reset on every `EpochSettled`). The first swap in the
///      pool after an epoch has ended triggers a callback, so the seat changes hands seconds after the epoch
///      closes instead of whenever the next CRON tick lands.
///   2. Finish deferred vault moves. When a takeover happens during a price push the hook emits
///      `VaultMoveDeferred` and leaves the vault where it was. The next swap after that triggers a callback that
///      finishes the move (the keeper calls `compound()`, which re-checks the price), and `VaultMoved` clears the
///      flag.
///
/// Safeguards:
///   - It only ever pokes the same OorkaKeeper code path anyone could call; the hook re-checks everything.
///   - A cooldown stops a burst of swaps from requesting a burst of callbacks.
///   - Logs from any other chain, pool or contract are ignored without reverting (reverts are still billed).
///   - The owner can pause it (unsubscribes from every topic). The CRON keeper keeps running independently as
///     the fallback for quiet pools, and `settleEpoch()` stays permissionless.
contract OorkaPulse {
    struct LogRecord {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
        bytes data;
        uint256 blockNumber;
        uint256 opCode;
        uint256 blockHash;
        uint256 txHash;
        uint256 logIndex;
    }

    IReactiveSystem public constant SYSTEM = IReactiveSystem(0x8888888888888888888888888888888888888888);
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint64 public constant CALLBACK_GAS_LIMIT = 3_000_000;

    /// v4 PoolManager: Swap(PoolId indexed id, address indexed sender, int128, int128, uint160, uint128, int24, uint24)
    uint256 public constant SWAP_TOPIC = uint256(keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
    /// OorkaHook: EpochSettled(uint256 indexed epoch, uint256 incumbentId, uint256 incumbentGrowthWad)
    uint256 public constant EPOCH_SETTLED_TOPIC = uint256(keccak256("EpochSettled(uint256,uint256,uint256)"));
    /// OorkaHook: VaultMoveDeferred(uint256 indexed incumbentId)
    uint256 public constant VAULT_MOVE_DEFERRED_TOPIC = uint256(keccak256("VaultMoveDeferred(uint256)"));
    /// OorkaHook: VaultMoved(int24 lower, int24 upper, uint128 liquidity)
    uint256 public constant VAULT_MOVED_TOPIC = uint256(keccak256("VaultMoved(int24,int24,uint128)"));

    enum Reason {
        EpochDue,
        VaultMovePending
    }

    uint256 public immutable originChainId;
    address public immutable poolManager;
    address public immutable hook;
    bytes32 public immutable poolId;
    uint256 public immutable epochLength;
    uint256 public immutable cooldown;
    address public immutable owner;

    address public keeper;
    bool public paused;
    /// @notice Reactive-side estimate of when the current epoch ends. Set from the hook at deploy and moved
    /// forward by `epochLength` every time the hook emits `EpochSettled`.
    uint256 public epochDueAt;
    bool public vaultMovePending;
    uint256 public lastRequestAt;
    uint256 public requests;

    event KeeperSet(address keeper);
    event Paused(bool paused);
    /// @notice A callback was requested. `originTx` is the Unichain transaction whose log triggered it, so the
    /// full loop (origin swap, reactive transaction, callback) can be measured.
    event Triggered(Reason indexed reason, uint256 indexed originBlock, uint256 originTx, uint256 request);
    event EpochClockSynced(uint256 epochDueAt);
    event VaultMoveFlag(bool pending);

    error NotAuthorized(address sender);
    error KeeperAlreadySet();
    error InsufficientFunds(uint256 required, uint256 available);
    error TransferFailed();

    modifier onlySystem() {
        if (msg.sender != address(SYSTEM)) revert NotAuthorized(msg.sender);
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized(msg.sender);
        _;
    }

    constructor(
        uint256 _originChainId,
        address _poolManager,
        address _hook,
        bytes32 _poolId,
        uint256 _epochLength,
        uint256 _firstEpochDueAt,
        uint256 _cooldown
    ) payable {
        originChainId = _originChainId;
        poolManager = _poolManager;
        hook = _hook;
        poolId = _poolId;
        epochLength = _epochLength;
        epochDueAt = _firstEpochDueAt;
        cooldown = _cooldown;
        owner = msg.sender;
        if (address(SYSTEM).code.length > 0) _subscribeAll();
    }

    /// @notice Point callbacks at the keeper. One-shot: the keeper authenticates this contract immutably.
    function setKeeper(address _keeper) external onlyOwner {
        if (keeper != address(0)) revert KeeperAlreadySet();
        keeper = _keeper;
        emit KeeperSet(_keeper);
    }

    /// @notice Stop or resume every subscription. Resuming settles any debt first.
    function setPaused(bool _paused) external onlyOwner {
        if (_paused == paused) return;
        paused = _paused;
        if (_paused) {
            _unsubscribeAll();
        } else {
            _coverDebt();
            _subscribeAll();
        }
        emit Paused(_paused);
    }

    function react(LogRecord calldata log) external onlySystem {
        if (log.chainId != originChainId) return;

        if (log.contractAddress == hook) {
            if (log.topic0 == EPOCH_SETTLED_TOPIC) {
                // the hook just rolled its epoch: the next one ends epochLength from now
                epochDueAt = block.timestamp + epochLength;
                lastRequestAt = 0;
                emit EpochClockSynced(epochDueAt);
            } else if (log.topic0 == VAULT_MOVE_DEFERRED_TOPIC) {
                vaultMovePending = true;
                emit VaultMoveFlag(true);
            } else if (log.topic0 == VAULT_MOVED_TOPIC) {
                if (vaultMovePending) {
                    vaultMovePending = false;
                    emit VaultMoveFlag(false);
                }
            }
            return;
        }

        if (log.contractAddress != poolManager || log.topic0 != SWAP_TOPIC || bytes32(log.topic1) != poolId) return;
        if (keeper == address(0)) return;
        if (lastRequestAt != 0 && block.timestamp < lastRequestAt + cooldown) return;

        Reason reason;
        if (block.timestamp >= epochDueAt) {
            reason = Reason.EpochDue;
        } else if (vaultMovePending) {
            reason = Reason.VaultMovePending;
        } else {
            return;
        }

        lastRequestAt = block.timestamp;
        uint256 n = ++requests;
        SYSTEM.requestCallbackV_1_0(
            IReactiveSystem.CallbackConfiguration_V_1_0({
                chainId: originChainId,
                recipient: keeper,
                gasLimit: CALLBACK_GAS_LIMIT,
                payload: abi.encodeWithSignature("poke(address)", address(0))
            })
        );
        emit Triggered(reason, log.blockNumber, log.txHash, n);
    }

    // ---------------------------------------------------------------- payments
    function pay(uint256 amount) external onlySystem {
        _pay(payable(msg.sender), amount);
    }

    function coverDebt() external {
        _coverDebt();
    }

    receive() external payable {}

    function _subscribeAll() internal {
        SYSTEM.subscribe(originChainId, poolManager, SWAP_TOPIC, uint256(poolId), REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId, hook, EPOCH_SETTLED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId, hook, VAULT_MOVE_DEFERRED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId, hook, VAULT_MOVED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _unsubscribeAll() internal {
        SYSTEM.unsubscribe(originChainId, poolManager, SWAP_TOPIC, uint256(poolId), REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.unsubscribe(originChainId, hook, EPOCH_SETTLED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.unsubscribe(originChainId, hook, VAULT_MOVE_DEFERRED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.unsubscribe(originChainId, hook, VAULT_MOVED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _coverDebt() internal {
        _pay(payable(address(SYSTEM)), SYSTEM.debt(address(this)));
    }

    function _pay(address payable to, uint256 amount) internal {
        if (address(this).balance < amount) revert InsufficientFunds(amount, address(this).balance);
        if (amount > 0) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
    }
}
