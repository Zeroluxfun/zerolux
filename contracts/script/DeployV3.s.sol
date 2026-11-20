// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ZeroLuxFactoryV3} from "../src/ZeroLuxFactoryV3.sol";

/// Deploys the version 3 factory on Robinhood Chain. It pays into the treasury that already exists.
/// GUARDIAN is optional and defaults to the owner; MARKUP_BPS is optional and defaults to 2000.
///   OWNER_KEY=... OPERATOR=0x... TREASURY=0x... [GUARDIAN=0x...] forge script script/DeployV3.s.sol --rpc-url $ETH_RPC_URL --broadcast
contract DeployV3 is Script {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432; // ERC-8004

    function run() external {
        require(block.chainid == 4663, "not Robinhood Chain");
        uint256 key = vm.envUint("OWNER_KEY");
        address owner = vm.addr(key);
        address operator = vm.envAddress("OPERATOR");
        address treasury = vm.envAddress("TREASURY");
        require(treasury.code.length != 0, "treasury is not a contract");
        uint16 markupBps = uint16(vm.envOr("MARKUP_BPS", uint256(2_000)));
        address guardian = vm.envOr("GUARDIAN", owner);

        vm.startBroadcast(key);
        ZeroLuxFactoryV3 factory =
            new ZeroLuxFactoryV3(USDG, owner, operator, treasury, markupBps, IDENTITY_REGISTRY, guardian);
        vm.stopBroadcast();

        console.log("owner    ", owner);
        console.log("operator ", operator);
        console.log("treasury ", treasury);
        console.log("guardian ", guardian);
        console.log("factory v3", address(factory));
        console.log("wallet implementation v3", factory.walletImplementation());
    }
}
