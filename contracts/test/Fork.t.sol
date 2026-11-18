// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactory} from "../src/ZeroLuxFactory.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {ZeroLuxTreasury} from "../src/ZeroLuxTreasury.sol";

interface IUSDG {
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function transferWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external;
}

/// Runs against a fork of Robinhood Chain with the real USDG. Skipped unless
/// FORK_RPC_URL is set:  FORK_RPC_URL=... forge test --match-contract ForkTest
contract ForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bool live;
    ZeroLuxFactory factory;
    ZeroLuxTreasury treasury;
    AgentWallet wallet;
    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    uint256 customerKey = 0xC0FFEE;
    address customer;

    function setUp() public {
        string memory url = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        live = true;
        customer = vm.addr(customerKey);
        treasury = new ZeroLuxTreasury(admin);
        factory = new ZeroLuxFactory(USDG, admin, operator, address(treasury), 2_000);
        (, address w) = factory.createAgent(alice, 1e6, 5e6, keccak256("spec"));
        wallet = AgentWallet(w);
        deal(USDG, customer, 10e6);
    }

    function test_fork_chain_is_robinhood() public view {
        if (!live) return;
        assertEq(block.chainid, 4663);
    }

    function test_fork_customer_pays_with_signed_authorization_then_charge_and_withdraw() public {
        if (!live) return;
        // 1. A customer pays the agent $2 with a signature; someone else sends it and pays the gas.
        bytes32 nonce = keccak256("call-1");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IUSDG(USDG).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(TRANSFER_TYPEHASH, customer, address(wallet), 2e6, 0, block.timestamp + 600, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(customerKey, digest);
        vm.prank(makeAddr("relayer"));
        IUSDG(USDG).transferWithAuthorization(customer, address(wallet), 2e6, 0, block.timestamp + 600, nonce, v, r, s);
        assertEq(IUSDG(USDG).balanceOf(address(wallet)), 2e6, "full amount arrives: no transfer fee");
        assertEq(IUSDG(USDG).balanceOf(customer), 8e6);

        // 2. The same signature cannot be used twice.
        uint256 deadline = block.timestamp + 600;
        try IUSDG(USDG).transferWithAuthorization(customer, address(wallet), 2e6, 0, deadline, nonce, v, r, s) {
            emit log_named_uint("REPLAY DID NOT REVERT, wallet balance now", IUSDG(USDG).balanceOf(address(wallet)));
        } catch (bytes memory err) {
            emit log_named_bytes("replay reverted with", err);
        }
        assertEq(IUSDG(USDG).balanceOf(address(wallet)), 2e6, "replay must not pay twice");

        // 2b. A signature for a different amount moves nothing.
        try IUSDG(USDG).transferWithAuthorization(customer, address(wallet), 3e6, 0, deadline, keccak256("call-2"), v, r, s) {
            emit log_named_uint("BAD SIGNATURE DID NOT REVERT, wallet balance now", IUSDG(USDG).balanceOf(address(wallet)));
        } catch (bytes memory err) {
            emit log_named_bytes("bad signature reverted with", err);
        }
        assertEq(IUSDG(USDG).balanceOf(address(wallet)), 2e6, "a bad signature must not pay");
        assertEq(IUSDG(USDG).balanceOf(customer), 8e6);

        // 3. The meter charges a run: cost plus 20% reaches the treasury, exactly.
        vm.prank(operator);
        wallet.charge("run-1", 500_000);
        assertEq(IUSDG(USDG).balanceOf(address(treasury)), 600_000);
        assertEq(IUSDG(USDG).balanceOf(address(wallet)), 1_400_000);

        // 4. The agent's owner takes the rest out; the treasury's owner takes the fee out.
        vm.prank(alice);
        wallet.withdraw(USDG, alice, 1_400_000);
        assertEq(IUSDG(USDG).balanceOf(alice), 1_400_000);
        vm.prank(admin);
        treasury.withdraw(USDG, admin, 600_000);
        assertEq(IUSDG(USDG).balanceOf(admin), 600_000);
        assertEq(IUSDG(USDG).balanceOf(address(wallet)), 0);
    }
}
