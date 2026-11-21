// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ZeroLuxMarket} from "../src/ZeroLuxMarket.sol";

interface IFactoryForMarket {
    function guardian() external view returns (address);
    function usdg() external view returns (address);
    function treasury() external view returns (address);
}

interface ILockerForMarket {
    function token() external view returns (address);
}

/// Deploys the pledge market on Robinhood Chain for the version 3 factory.
/// The guardian is the factory's guardian as it stands; the sale fee is 2.5%.
/// The deployer keeps no power over the market.
/// LOCKER is the LuxLocker a seller's bond is read from, BOND the $LUX a seller
/// must have locked there (in the token's smallest units, 18 decimals), and
/// BOND_DAYS how many days past the listing that lock must run. All three must
/// be given. To deploy a market that asks no bond, say so outright with
/// LOCKER=0x0000000000000000000000000000000000000000 BOND=0 BOND_DAYS=0.
///   DEPLOYER_KEY=... FACTORY=0x... LOCKER=0x... BOND=... BOND_DAYS=... forge script script/DeployMarket.s.sol --rpc-url $ETH_RPC_URL --broadcast
contract DeployMarket is Script {
    uint16 constant FEE_BPS = 250;

    function run() external {
        require(block.chainid == 4663, "not Robinhood Chain");
        uint256 key = vm.envUint("DEPLOYER_KEY");
        address factory = vm.envAddress("FACTORY");
        require(factory.code.length != 0, "factory is not a contract");
        address guardian = IFactoryForMarket(factory).guardian();
        address locker = vm.envAddress("LOCKER");
        uint256 bond = vm.envUint("BOND");
        uint256 bondDays = vm.envUint("BOND_DAYS");
        require(bondDays <= type(uint32).max, "BOND_DAYS too large");
        // Either a whole bond or none: half a setting would switch the bond off without a word.
        require((locker == address(0)) == (bond == 0), "LOCKER and BOND must both be set or both be zero");
        if (locker != address(0)) {
            require(locker.code.length != 0, "locker is not a contract");
            require(bondDays != 0, "BOND_DAYS is zero");
        } else {
            require(bondDays == 0, "BOND_DAYS without a bond");
        }

        vm.startBroadcast(key);
        ZeroLuxMarket market = new ZeroLuxMarket(factory, guardian, FEE_BPS, locker, bond, uint32(bondDays));
        vm.stopBroadcast();

        console.log("factory  ", factory);
        console.log("guardian ", guardian);
        console.log("usdg     ", market.usdg());
        console.log("treasury ", IFactoryForMarket(factory).treasury());
        console.log("fee bps  ", market.feeBps());
        console.log("locker   ", market.locker());
        if (locker != address(0)) console.log("lux      ", ILockerForMarket(locker).token());
        console.log("bond     ", market.bond());
        console.log("bond days", market.bondDays());
        console.log("market   ", address(market));
    }
}
