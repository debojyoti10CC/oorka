// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IOorkaHook {
    function epochInfo() external view returns (uint256 current, uint256 start, uint256 end, uint256 nowTs);
    function settleEpoch() external;
    function compound() external;
}

/// @notice Reactive Network callback proxy (the subset the keeper uses).
interface ICallbackProxy {
    function debt(address contract_) external view returns (uint256);
}

/// @title OorkaKeeper
/// @notice Destination-chain half of Oorka's keeper-free automation. Reactive Network calls `poke` on a CRON
/// schedule (see OorkaReactive). If the hook's epoch is over, the keeper settles it; otherwise it does nothing.
/// `settleEpoch()` is permissionless, so the keeper needs no special rights on the hook. All it adds is liveness:
/// the seat changes hands on time even when nobody is watching.
/// @dev Deploy on the hook's chain after OorkaReactive, passing that chain's Reactive callback proxy and the
/// OorkaReactive address. Every callback is checked twice: it must come through the proxy, and the sender address
/// the network injects into the first argument must be our reactive contract. Fund it with native gas: the proxy
/// bills callback costs to the recipient.
contract OorkaKeeper {
    ICallbackProxy public immutable callbackProxy;
    address public immutable callbackSender; // OorkaReactive on Reactive Network
    IOorkaHook public immutable hook;
    bool public immutable compoundOnIdle;

    event Settled(uint256 indexed epoch);
    event SettleFailed(uint256 indexed epoch, bytes reason);
    event Compounded();
    event Idle(uint256 indexed epoch, uint256 secondsLeft);

    error NotAuthorized(address sender);
    error CallbackNotAuthorized(address sender, address expected);
    error InsufficientFunds(uint256 required, uint256 available);
    error TransferFailed();

    modifier onlyProxy() {
        if (msg.sender != address(callbackProxy)) revert NotAuthorized(msg.sender);
        _;
    }

    constructor(address _callbackProxy, address _callbackSender, IOorkaHook _hook, bool _compoundOnIdle) payable {
        callbackProxy = ICallbackProxy(_callbackProxy);
        callbackSender = _callbackSender;
        hook = _hook;
        compoundOnIdle = _compoundOnIdle;
    }

    /// @param sender Replaced by Reactive Network with the address of the reactive contract that requested the
    /// callback.
    function poke(address sender) external onlyProxy {
        if (sender != callbackSender) revert CallbackNotAuthorized(sender, callbackSender);
        (uint256 current,, uint256 end, uint256 nowTs) = hook.epochInfo();
        if (nowTs >= end) {
            // never let one failed settle wedge the schedule: report it and try again on the next tick
            try hook.settleEpoch() {
                emit Settled(current);
            } catch (bytes memory reason) {
                emit SettleFailed(current, reason);
            }
            return;
        }
        if (compoundOnIdle) {
            try hook.compound() {
                emit Compounded();
            } catch {}
        }
        emit Idle(current, end - nowTs);
    }

    // ---------------------------------------------------------------- payments
    /// @notice Called by the callback proxy to collect what this contract owes for callbacks.
    function pay(uint256 amount) external onlyProxy {
        _pay(payable(msg.sender), amount);
    }

    /// @notice Settle outstanding debt to the proxy from this contract's balance.
    function coverDebt() external {
        _pay(payable(address(callbackProxy)), callbackProxy.debt(address(this)));
    }

    receive() external payable {}

    function _pay(address payable to, uint256 amount) internal {
        if (address(this).balance < amount) revert InsufficientFunds(amount, address(this).balance);
        if (amount > 0) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
    }
}
