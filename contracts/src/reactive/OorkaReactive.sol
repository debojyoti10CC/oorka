// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Reactive Network's system contract interface (the subset Oorka uses). Matches reactive-lib-omni's
/// ISystemContract: subscriptions, callback requests, and debt lookups.
interface IReactiveSystem {
    struct CallbackConfiguration_V_1_0 {
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    function subscribe(uint256 chainId, address contract_, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external;
    function unsubscribe(uint256 chainId, address contract_, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external;
    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config) external;
    function debt(address contract_) external view returns (uint256);
}

/// @title OorkaReactive
/// @notice Reactive Network half of Oorka's keeper-free automation. It subscribes to one of Reactive Network's
/// built-in CRON events and, every `ticksPerPoke` ticks, asks the system contract to post a callback to
/// OorkaKeeper on the hook's chain. The keeper checks whether the epoch is over and settles it. No bot, no
/// off-chain keeper, no trusted operator.
///
/// Written against Reactive Network's current contract model: one copy of the contract, `react()` called
/// directly by the system contract at 0x8888…8888, and callbacks requested with `requestCallbackV_1_0`. The
/// destination sees this contract's own address as the callback sender. (The older ReactVM model, where `react()`
/// ran in a separate VM copy behind a `vmOnly` check, no longer receives events on Lasna or Mainnet.)
///
/// CRON topics (topic_0, emitted by the legacy system address 0x…fffFfF):
///   Cron1     every block          0xf02d6ea5c22a71cffe930a4523fcb4f129be6c804db50e4202fb4e0b07ccb514
///   Cron10    every 10 blocks      0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687
///   Cron100   every 100 blocks     0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70
///   Cron1000  every 1,000 blocks   0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4
/// Pick a cadence a little faster than the hook's epoch length, so the seat changes hands soon after an epoch ends.
contract OorkaReactive {
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

    /// @notice Reactive Network's system contract (Mainnet and Lasna): calls react(), bills, posts callbacks.
    IReactiveSystem public constant SYSTEM = IReactiveSystem(0x8888888888888888888888888888888888888888);
    /// @notice Legacy system address that emits the CRON events.
    address public constant CRON_SOURCE = 0x0000000000000000000000000000000000fffFfF;
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint64 public constant CALLBACK_GAS_LIMIT = 3_000_000; // a takeover migrates the vault: budget for it

    uint256 public immutable cronTopic;
    uint256 public immutable destinationChainId;
    uint256 public immutable ticksPerPoke;
    address public immutable owner;

    /// @notice OorkaKeeper on the destination chain. Set once, after the keeper is deployed with this contract's
    /// address (the keeper needs ours at construction, so the cycle breaks here).
    address public keeper;
    bool public paused;
    uint256 public ticks;

    event KeeperSet(address keeper);
    event Poked(uint256 tick);
    event Paused(bool paused);

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

    constructor(uint256 _cronTopic, uint256 _destinationChainId, uint256 _ticksPerPoke) payable {
        cronTopic = _cronTopic;
        destinationChainId = _destinationChainId;
        ticksPerPoke = _ticksPerPoke == 0 ? 1 : _ticksPerPoke;
        owner = msg.sender;
        // the system contract only has code on Reactive Network; skip the subscription in unit tests elsewhere
        if (address(SYSTEM).code.length > 0) _subscribe();
    }

    /// @notice Point the callbacks at the keeper. One-shot: the keeper authenticates this contract immutably, so
    /// there's nothing to rotate.
    function setKeeper(address _keeper) external onlyOwner {
        if (keeper != address(0)) revert KeeperAlreadySet();
        keeper = _keeper;
        emit KeeperSet(_keeper);
    }

    /// @notice Stop or resume the CRON subscription. Cron ticks bill whether or not anything happens, so this is
    /// the off switch. Resuming settles any debt first, since a contract in debt receives nothing.
    function setPaused(bool _paused) external onlyOwner {
        if (_paused == paused) return;
        paused = _paused;
        if (_paused) {
            SYSTEM.unsubscribe(block.chainid, CRON_SOURCE, cronTopic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        } else {
            _coverDebt();
            _subscribe();
        }
        emit Paused(_paused);
    }

    function react(LogRecord calldata log) external onlySystem {
        // non-matching logs fall through quietly: reverting as a filter still gets billed
        if (log.topic0 != cronTopic || keeper == address(0)) return;
        uint256 t = ++ticks;
        if (t % ticksPerPoke != 0) return;
        // the first argument is overwritten with this contract's address by Reactive Network
        SYSTEM.requestCallbackV_1_0(
            IReactiveSystem.CallbackConfiguration_V_1_0({
                chainId: destinationChainId,
                recipient: keeper,
                gasLimit: CALLBACK_GAS_LIMIT,
                payload: abi.encodeWithSignature("poke(address)", address(0))
            })
        );
        emit Poked(t);
    }

    // ---------------------------------------------------------------- payments
    /// @notice Called by the system contract to collect what this contract owes for its reactive transactions.
    function pay(uint256 amount) external onlySystem {
        _pay(payable(msg.sender), amount);
    }

    /// @notice Settle outstanding debt from this contract's balance. Open to anyone, so a third party can fund
    /// the contract and restart it.
    function coverDebt() external {
        _coverDebt();
    }

    receive() external payable {}

    function _subscribe() internal {
        SYSTEM.subscribe(block.chainid, CRON_SOURCE, cronTopic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
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
