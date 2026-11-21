// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AbstractCallback} from "reactive-lib/abstract-base/AbstractCallback.sol";

interface IOorkaHook {
    function epochInfo() external view returns (uint256 current, uint256 start, uint256 end, uint256 nowTs);
    function settleEpoch() external;
    function compound() external;
}

/// @title OorkaKeeper
/// @notice Destination-chain half of Oorka's keeper-free automation. Reactive Network calls `poke` on a CRON
/// schedule (see OorkaReactive). If the hook's epoch is over, the keeper settles it; otherwise it does nothing.
/// `settleEpoch()` is permissionless, so the keeper needs no special rights on the hook. All it adds is liveness:
/// the seat changes hands on time even when nobody is watching.
/// @dev Deploy on the hook's chain with that chain's Reactive callback proxy, from the same EOA that deploys
/// OorkaReactive on Reactive Network (that EOA is the RVM id the keeper accepts). Fund it with native gas:
/// Reactive charges callback costs to the destination contract.
contract OorkaKeeper is AbstractCallback {
    IOorkaHook public immutable hook;
    bool public immutable compoundOnIdle;

    event Settled(uint256 indexed epoch);
    event SettleFailed(uint256 indexed epoch, bytes reason);
    event Compounded();
    event Idle(uint256 indexed epoch, uint256 secondsLeft);

    constructor(address callbackProxy, IOorkaHook _hook, bool _compoundOnIdle)
        payable
        AbstractCallback(callbackProxy)
    {
        hook = _hook;
        compoundOnIdle = _compoundOnIdle;
    }

    /// @param rvm Replaced by Reactive Network with the RVM id of the reactive contract that sent the callback.
    function poke(address rvm) external authorizedSenderOnly rvmIdOnly(rvm) {
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
}
