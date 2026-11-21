// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {LuxLocker} from "../src/LuxLocker.sol";

interface ITokenForLocker {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// Deploys the $LUX locker on Robinhood Chain. LUX is the token's address and
/// must be the real token, already deployed. The locker has no owner and the
/// deployer keeps no power over it.
///   DEPLOYER_KEY=... LUX=0x... forge script script/DeployLocker.s.sol --rpc-url $ETH_RPC_URL --broadcast
contract DeployLocker is Script {
    function run() external {
        require(block.chainid == 4663, "not Robinhood Chain");
        uint256 key = vm.envUint("DEPLOYER_KEY");
        address lux = vm.envAddress("LUX");
        require(lux.code.length != 0, "LUX is not a contract");
        require(ITokenForLocker(lux).decimals() == 18, "LUX does not have 18 decimals");

        vm.startBroadcast(key);
        LuxLocker locker = new LuxLocker(lux);
        vm.stopBroadcast();

        console.log("token    ", locker.token());
        console.log("symbol   ", ITokenForLocker(lux).symbol());
        console.log("min lock ", uint256(locker.MIN_LOCK()));
        console.log("max lock ", uint256(locker.MAX_LOCK()));
        console.log("locker   ", address(locker));
    }
}
