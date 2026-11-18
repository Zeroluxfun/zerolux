// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ZeroLuxFactory} from "../src/ZeroLuxFactory.sol";
import {ZeroLuxTreasury} from "../src/ZeroLuxTreasury.sol";

/// Deploys the treasury and the factory on Robinhood Chain.
///   OWNER_KEY=... OPERATOR=0x... forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL --broadcast
contract Deploy is Script {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432; // ERC-8004

    function run() external {
        require(block.chainid == 4663, "not Robinhood Chain");
        uint256 key = vm.envUint("OWNER_KEY");
        address owner = vm.addr(key);
        address operator = vm.envAddress("OPERATOR");
        uint16 markupBps = uint16(vm.envOr("MARKUP_BPS", uint256(2_000)));

        vm.startBroadcast(key);
        ZeroLuxTreasury treasury = new ZeroLuxTreasury(owner);
        ZeroLuxFactory factory =
            new ZeroLuxFactory(USDG, owner, operator, address(treasury), markupBps, IDENTITY_REGISTRY);
        vm.stopBroadcast();

        console.log("owner    ", owner);
        console.log("operator ", operator);
        console.log("treasury ", address(treasury));
        console.log("factory  ", address(factory));
        console.log("wallet implementation", factory.walletImplementation());
    }
}
