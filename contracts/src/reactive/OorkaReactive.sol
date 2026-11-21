// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AbstractPausableReactive} from "reactive-lib/abstract-base/AbstractPausableReactive.sol";

/// @title OorkaReactive
/// @notice Reactive Network half of Oorka's keeper-free automation. It subscribes to one of Reactive Network's
/// built-in CRON events and, every `ticksPerPoke` ticks, sends a callback to OorkaKeeper on the hook's chain.
/// The keeper checks whether the epoch is over and settles it. No bot, no off-chain keeper, no trusted operator.
///
/// CRON topics on Reactive Network (topic_0, emitted by the system contract):
///   Cron1     every block          0xf02d6ea5c22a71cffe930a4523fcb4f129be6c804db50e4202fb4e0b07ccb514
///   Cron10    every 10 blocks      0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687
///   Cron100   every 100 blocks     0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70
///   Cron1000  every 1,000 blocks   0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4
/// Pick a cadence a little faster than the hook's epoch length, so the seat changes hands soon after an epoch ends.
contract OorkaReactive is AbstractPausableReactive {
    uint64 public constant CALLBACK_GAS_LIMIT = 3_000_000; // a takeover migrates the vault: budget for it

    uint256 public immutable cronTopic;
    uint256 public immutable destinationChainId;
    address public immutable keeper;
    uint256 public immutable ticksPerPoke;

    uint256 public ticks; // RVM-side counter

    event Poked(uint256 tick);

    constructor(uint256 _cronTopic, uint256 _destinationChainId, address _keeper, uint256 _ticksPerPoke) payable {
        cronTopic = _cronTopic;
        destinationChainId = _destinationChainId;
        keeper = _keeper;
        ticksPerPoke = _ticksPerPoke == 0 ? 1 : _ticksPerPoke;
        if (!vm) {
            service.subscribe(block.chainid, address(service), _cronTopic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
    }

    function getPausableSubscriptions() internal view override returns (Subscription[] memory subs) {
        subs = new Subscription[](1);
        subs[0] = Subscription(block.chainid, address(service), cronTopic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function react(LogRecord calldata log) external vmOnly {
        if (log.topic_0 != cronTopic) return;
        ticks += 1;
        if (ticks % ticksPerPoke != 0) return;
        // the first argument is overwritten with this contract's RVM id by Reactive Network
        emit Callback(destinationChainId, keeper, CALLBACK_GAS_LIMIT, abi.encodeWithSignature("poke(address)", address(0)));
        emit Poked(ticks);
    }
}
