// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {MarketBase} from "./Market.t.sol";
import {ZeroLuxMarket} from "../src/ZeroLuxMarket.sol";

contract ReviewMarketTest is MarketBase {
    function _unsettledRun() internal {
        bytes32 id = keccak256("unsettled-run");
        _payTo(wallet, customer, 6e6, id, 5e6);
        vm.prank(operator);
        wallet.charge(id, 1e6, RCPT); // profit +4.8, checkpoint NOT moved
    }

    function _settleAndReport() internal returns (uint256) {
        vm.prank(operator);
        wallet.settle(type(uint256).max);
        wallet.settleLien();
        return usdg.balanceOf(backer);
    }

    // F1 baseline: honest listing, buyer gets bps of the profit that was unsettled at purchase.
    function test_F1_honest_baseline() public {
        _pledgeAndList(wallet, alice);
        _unsettledRun();
        _buy(wallet, backer);
        assertEq(_settleAndReport(), 900e6 + 1.2e6);
    }

    // F1: seller front-runs with cancel / setLien (identical bps+cap) / list (identical price).
    // FIXED: the buyer names the starting profit they saw (maxBase); the remade pledge starts
    // above it, so the purchase reverts and the buyer pays nothing.
    function test_F1_front_run_recreates_pledge_with_worse_base() public {
        _pledgeAndList(wallet, alice);
        _unsettledRun();
        uint256 seenBase = market.offer(address(wallet)).baseProfit;
        vm.startPrank(alice);
        market.cancel(address(wallet));
        wallet.setLien(_escrow(wallet), BPS, CAP);
        market.list(address(wallet), PRICE, BPS, CAP);
        vm.stopPrank();
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.BaseTooHigh.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, 0, seenBase);
        assertEq(usdg.balanceOf(backer), 1_000e6, "the attack fails: the buyer paid nothing");
    }

    // F3: blocked / reverting treasury.
    // FIXED: the purchase goes through, the fee goes to the seller, cancel still works elsewhere.
    function test_F3_blocked_treasury_halts_buys_but_not_cancel() public {
        _pledgeAndList(wallet, alice);
        _pledgeAndList(wallet2, bob);
        usdg.setBlocked(treasury, true);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(_payee(wallet), backer);
        assertEq(usdg.balanceOf(alice), 100e6);
        assertEq(usdg.balanceOf(backer), 900e6);
        vm.prank(bob);
        market.cancel(address(wallet2));
        assertEq(_payee(wallet2), address(0));
    }

    // F4: after the wallet changes hands the old seller tried to collect what the pledge pays
    // on the new owner's watch.
    // FIXED: a listing is the seller's only while they own the wallet; the escrow goes with it.
    function test_F4_stale_seller_collects_post_transfer_payouts() public {
        _pledgeAndList(wallet, alice);
        vm.prank(alice);
        wallet.transferOwnership(bob);
        vm.prank(bob);
        wallet.acceptOwnership();
        _earn(wallet); // earned under bob
        wallet.settleLien();
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.collect(address(wallet), alice);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.cancel(address(wallet));
        vm.prank(bob);
        assertEq(market.collect(address(wallet), bob), 1.2e6);
    }
}
