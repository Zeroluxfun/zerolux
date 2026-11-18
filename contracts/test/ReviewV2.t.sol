// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactoryV2} from "../src/ZeroLuxFactoryV2.sol";
import {AgentWalletV2} from "../src/AgentWalletV2.sol";

/// Independent review of version 2 (holds, scoped ERC-1271). Every test passes when the
/// behaviour in its name is real. test_rv2_FINDING_* / test_rv2_note_* show something to
/// fix or to know; test_rv2_held_* show an attack that failed.

interface I1271 {
    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4);
}

/// USDG stand-in: issuer block list, EIP-3009 where a used authorization is accepted and
/// moves nothing, and (worst case) contract signatures honoured through ERC-1271.
contract RV2USDG {
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public blocked;
    mapping(address => mapping(bytes32 => bool)) public used;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked[msg.sender] && !blocked[to], "blocked");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    /// v == 27 stands for a good customer signature. Callable by ANYONE who has it.
    function transferWithAuthorization(
        address from, address to, uint256 value, uint256, uint256 validBefore, bytes32 nonce, uint8 v, bytes32, bytes32
    ) external {
        require(block.timestamp < validBefore, "expired");
        require(v == 27, "bad signature");
        if (used[from][nonce]) return;
        used[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    /// The same transfer for a contract `from`, checked with ERC-1271, as USDC v2.2 does.
    function transferWithContractAuthorization(address from, address to, uint256 value, bytes32 nonce, bytes calldata sig)
        external
    {
        bytes32 digest = authDigest(from, to, value, nonce);
        require(I1271(from).isValidSignature(digest, sig) == 0x1626ba7e, "bad signature");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function authDigest(address from, address to, uint256 value, bytes32 nonce) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(address verifyingContract)"), address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode("Transfer", from, to, value, nonce))));
    }
}

/// The ERC-8004 registry's wallet-setting logic as described: caller must own the
/// identity; digest uses owner = ownerOf(agentId); ECDSA first, then ERC-1271.
contract RV2Registry {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public agentWallet;
    uint256 public next = 1;

    function mint(address to) external returns (uint256 id) {
        id = next++;
        ownerOf[id] = to;
    }

    function digestFor(uint256 agentId, address newWallet, address owner_, uint256 deadline) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                agentId,
                newWallet,
                owner_,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external {
        require(msg.sender == ownerOf[agentId], "not owner");
        require(block.timestamp <= deadline, "expired");
        bytes32 d = digestFor(agentId, newWallet, ownerOf[agentId], deadline);
        (bool ok, bytes memory ret) = newWallet.staticcall(abi.encodeCall(I1271.isValidSignature, (d, signature)));
        require(ok && ret.length == 32 && abi.decode(ret, (bytes4)) == 0x1626ba7e, "bad wallet signature");
        agentWallet[agentId] = newWallet;
    }
}

contract ReviewV2Test is Test {
    RV2USDG usdg;
    RV2Registry registry;
    ZeroLuxFactoryV2 factory;
    AgentWalletV2 wallet;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    uint256 aliceKey = 0xA11CE;
    address alice;
    uint256 bobKey = 0xB0B;
    address bob;
    address customer = makeAddr("customer");
    address lender = makeAddr("lender");
    address mallory = makeAddr("mallory");

    uint128 constant RUN_CAP = 1e6; // $1 a run, fee included
    uint128 constant DAY_CAP = 5e6;

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);
        usdg = new RV2USDG();
        registry = new RV2Registry();
        factory = new ZeroLuxFactoryV2(address(usdg), admin, operator, treasury, 2_000, address(registry));
        (, address w) = factory.createAgent(alice, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_000);
        wallet = AgentWalletV2(w);
        usdg.mint(customer, 1_000e6);
    }

    function _pay(bytes32 nonce, uint256 value, bytes32 runId, uint256 budget) internal {
        vm.prank(operator);
        wallet.pay(customer, value, 0, block.timestamp + 600, nonce, 27, bytes32(0), bytes32(0), runId, budget);
    }

    function _settleAll() internal {
        vm.prank(operator);
        wallet.settle(type(uint256).max);
    }

    function _today() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    // =====================================================================
    // FINDINGS AND NOTES
    // =====================================================================

    /// L1. A hold cannot be renewed and anyone may release it after a day. A run
    /// (or a bill) that takes longer than 24 hours loses its cover: the owner
    /// releases the hold herself, withdraws, and the run cannot be charged.
    /// "A run that was let in can always be billed" is true for one day only.
    function test_rv2_FINDING_a_run_longer_than_a_day_loses_its_hold_and_the_owner_takes_the_money() public {
        _pay("n1", 1e6, "long run", 800_000);
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(alice);
        wallet.release("long run");
        wallet.withdraw(address(usdg), alice, 1e6);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotOpen.selector);
        wallet.charge("long run", 800_000);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.TransferFailed.selector);
        wallet.open("long run", 800_000);
    }

    /// L2. `pay` uses transferWithAuthorization, which anyone holding the signed
    /// authorization can submit. If it is submitted outside `pay`, the money
    /// lands with no hold, `pay` reverts NotPaid, and until the meter calls
    /// `open` the owner can simply withdraw it: the customer has paid, no run is
    /// covered. receiveWithAuthorization (same EIP) can only be submitted by
    /// the payee and closes this.
    function test_rv2_FINDING_authorization_submitted_outside_pay_leaves_the_payment_unheld() public {
        vm.prank(mallory); // or the owner, or the customer
        usdg.transferWithAuthorization(customer, address(wallet), 1e6, 0, block.timestamp + 600, "n1", 27, 0, 0);

        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotPaid.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 800_000);

        uint256 snap = vm.snapshotState();
        vm.prank(operator);
        wallet.open("r1", 800_000); // the intended recovery works if the meter is first
        assertEq(wallet.heldTotal(), 960_000);
        vm.revertToState(snap);

        vm.prank(alice); // ... and fails if the owner is first
        wallet.withdraw(address(usdg), alice, 1e6);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.TransferFailed.selector);
        wallet.open("r1", 800_000);
        assertEq(usdg.balanceOf(customer), 999e6, "customer paid, owner has it, no run");
    }

    /// Note. The pause switch and setLimits(0,0) no longer stop a hostile meter
    /// at once: holds it opened beforehand stay chargeable, and the owner cannot
    /// release them for a day. Unreleased holds also pile up across days, so the
    /// treasury can receive several day caps in one block. The total per day
    /// opened is still perDayCap.
    function test_rv2_note_pause_does_not_stop_holds_already_open_and_old_holds_pile_up() public {
        usdg.mint(address(wallet), 100e6);
        for (uint256 d = 0; d < 3; d++) {
            for (uint256 i = 0; i < 5; i++) {
                vm.prank(operator);
                wallet.open(bytes32(d * 10 + i + 1), 833_333); // ~$1 with the fee
            }
            vm.warp(block.timestamp + 1 days);
        }
        vm.startPrank(alice);
        wallet.setPaused(true);
        wallet.setLimits(0, 0);
        vm.stopPrank();
        for (uint256 d = 0; d < 3; d++) {
            for (uint256 i = 0; i < 5; i++) {
                vm.prank(operator);
                wallet.charge(bytes32(d * 10 + i + 1), 833_333);
            }
        }
        assertGt(usdg.balanceOf(treasury), 14_999_000, "three day caps in one block, after the pause");
    }

    /// Note. Under a lien, a paid run is counted twice in withdrawable(): once as
    /// a hold and once as unsettled income. The owner's own settled money is
    /// locked by the size of the open holds until they are billed. Temporary,
    /// and the capped exit does not use this figure.
    function test_rv2_note_holds_are_counted_twice_against_the_owner_under_a_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 10e6);
        _settleAll();
        wallet.settleLien(); // lender 5, alice's settled 5 remain
        assertEq(wallet.withdrawable(), 5e6);
        _pay("n1", 1e6, "r1", 800_000);
        assertEq(wallet.withdrawable(), 5e6 - 960_000, "her own settled money is short by the hold");
        vm.prank(operator);
        wallet.chargeAndSettle("r1", 800_000, type(uint256).max);
        assertEq(wallet.withdrawable(), 5e6 + 20_000);
    }

    /// Note. With value 0 the "money arrived" check passes for any authorization
    /// USDG does not revert on, so pay(…, 0, …) is just open().
    function test_rv2_note_pay_with_zero_value_is_open() public {
        usdg.mint(address(wallet), 1e6);
        _pay("n1", 0, "r1", 800_000);
        _pay("n1", 0, "r2", 10_000); // same nonce again
        assertEq(wallet.heldTotal(), 960_000 + 12_000);
        assertEq(usdg.balanceOf(customer), 1_000e6);
    }

    // =====================================================================
    // HOLDS: WHAT HELD
    // =====================================================================

    /// The owner cannot get held money out by any route: withdraw, a 100% lien to
    /// herself, the capped exit, or parked money.
    function test_rv2_held_owner_cannot_reach_held_money() public {
        address alt = makeAddr("alice alt");
        vm.prank(alice);
        wallet.setLien(alt, 10_000, 1e6);
        _pay("n1", 1e6, "r1", 800_000);
        _settleAll(); // even with the checkpoint (wrongly) at full profit
        assertEq(wallet.withdrawable(), 0);
        vm.prank(alice);
        vm.expectRevert(AgentWalletV2.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);
        assertEq(wallet.settleLien(), 40_000, "only the part not set aside");
        vm.prank(alice);
        vm.expectRevert(AgentWalletV2.LienStands.selector);
        wallet.endLien(); // capped exit: the rest is not there to take

        // parked money and holds are both reserved
        usdg.setBlocked(alt, true);
        usdg.mint(address(wallet), 960_000);
        _settleAll();
        vm.prank(alice);
        wallet.endLien(); // parks 960_000 for alt
        assertEq(wallet.parkedTotal(), 960_000);
        vm.prank(alt);
        wallet.claimParked(mallory);
        assertEq(usdg.balanceOf(address(wallet)), wallet.heldTotal());
        vm.prank(operator);
        wallet.charge("r1", 800_000);
        assertEq(usdg.balanceOf(treasury), 960_000);
    }

    /// Whatever the owner changes between open and charge, the treasury can be
    /// paid up to the hold and never more. A higher markup lowers the cost that
    /// fits, not the total.
    function test_rv2_held_owner_changes_between_open_and_charge() public {
        _pay("n1", 1e6, "r1", 800_000); // hold 960_000 at 20%
        vm.prank(admin);
        factory.setMarkup(5_000);
        vm.startPrank(alice);
        wallet.adoptTerms(treasury, 5_000);
        wallet.setPaused(true);
        wallet.setLimits(0, 0);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.OverRunCap.selector);
        wallet.charge("r1", 800_000); // 1_200_000 would exceed the hold
        vm.prank(operator);
        wallet.charge("r1", 640_000); // 640_000 * 1.5 = 960_000
        assertEq(usdg.balanceOf(treasury), 960_000);
        assertEq(wallet.heldTotal(), 0);
        assertEq(wallet.spentOnDay(_today()), 960_000);
    }

    /// Day accounting across midnight: no underflow, nothing counted twice, the
    /// unused part goes back to the day the hold was opened on, and a released
    /// run id can be used again while a charged one cannot.
    function test_rv2_held_day_accounting_across_days_and_run_id_reuse() public {
        uint256 d0 = _today();
        _pay("n1", 1e6, "a", 800_000);
        _pay("n2", 1e6, "b", 800_000);
        _pay("n3", 1e6, "c", 800_000);
        assertEq(wallet.spentOnDay(d0), 2_880_000);
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        wallet.charge("a", 100_000); // 120_000 billed
        vm.prank(mallory);
        wallet.release("b"); // anyone, a day old
        assertEq(wallet.spentOnDay(d0), 120_000 + 960_000);
        assertEq(wallet.spentOnDay(d0 + 1), 0);
        vm.prank(operator);
        wallet.release("c");
        assertEq(wallet.spentOnDay(d0), 120_000);
        assertEq(wallet.heldTotal(), 0);

        vm.prank(operator);
        wallet.open("b", 800_000); // reuse after release
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.RunAlreadyCharged.selector);
        wallet.open("a", 1); // never after a charge
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotOpen.selector);
        wallet.charge("a", 1);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotOpen.selector);
        wallet.release("c");
        assertEq(wallet.spentOnDay(d0 + 1), 960_000);
    }

    /// A hostile meter cannot set aside more than the day cap in a day, cannot
    /// win the limit back by opening and charging a pittance, and cannot charge
    /// more than a hold.
    function test_rv2_held_operator_bounds() public {
        usdg.mint(address(wallet), 100e6);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(operator);
            wallet.open(bytes32(i + 1), 833_333);
        }
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.OverDayCap.selector);
        wallet.open("more", 10);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.OverRunCap.selector);
        wallet.charge(bytes32(uint256(1)), 833_334);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(operator);
            wallet.charge(bytes32(i + 1), 833_333);
        }
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.OverDayCap.selector);
        wallet.open("more", 10); // charged money stays counted
        assertLe(usdg.balanceOf(treasury), DAY_CAP);
        assertEq(wallet.withdrawable(), usdg.balanceOf(address(wallet)));
    }

    /// If the wallet cannot take the run, the customer is not charged; a payment
    /// smaller than the hold needs free money in the wallet.
    function test_rv2_held_customer_never_pays_without_a_hold() public {
        vm.prank(alice);
        wallet.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.Paused.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 800_000);
        vm.prank(alice);
        wallet.setPaused(false);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.TransferFailed.selector);
        wallet.pay(customer, 500_000, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 800_000);
        assertEq(usdg.balanceOf(customer), 1_000e6);
        assertEq(usdg.balanceOf(address(wallet)), 0);
    }

    /// Holds, lien, parking and the fallback checkpoint together, random order,
    /// meter free to pass any figure. Money set aside or parked is always in the
    /// wallet; heldTotal is the sum of the holds; the day's total never passes
    /// the cap; the payee never gets more than bps of peak profit or more than
    /// cap; the owner never withdraws past withdrawable(); nothing reverts
    /// unexpectedly.
    bytes32[] ids;
    bool lienOn;
    uint256 fzCap;

    function _fzPay(bytes32 id, uint256 x, uint256 budget) internal {
        vm.prank(operator);
        try wallet.pay(customer, x, 0, block.timestamp + 600, id, 27, bytes32(0), bytes32(0), id, budget) {
            ids.push(id);
        } catch {}
    }

    function _fzStep(uint256 seed, bytes32 id) internal {
        uint256 op = seed % 11;
        uint256 x = (seed >> 8) % 3e6;
        uint256 n = ids.length;
        if (op == 0) {
            usdg.mint(address(wallet), x);
        } else if (op == 1 || op == 2) {
            _fzPay(id, x, (seed >> 40) % 2e6);
        } else if (op == 3) {
            vm.prank(operator);
            try wallet.open(id, (seed >> 40) % 2e6) {
                ids.push(id);
            } catch {}
        } else if (op == 4 && n != 0) {
            bytes32 r = ids[(seed >> 80) % n];
            (uint128 amt,,) = wallet.holds(r);
            uint256 maxCost = (uint256(amt) * 10_000) / 12_000;
            if (maxCost != 0) {
                vm.prank(operator);
                wallet.chargeAndSettle(r, 1 + (seed >> 100) % maxCost, (seed >> 140) % 30e6);
            }
        } else if (op == 5 && n != 0) {
            bytes32 r = ids[(seed >> 80) % n];
            (uint128 amt,,) = wallet.holds(r);
            if (amt != 0) {
                vm.prank(operator);
                wallet.release(r);
            }
        } else if (op == 6) {
            vm.prank(operator);
            wallet.settle((seed >> 140) % 30e6);
        } else if (op == 7) {
            uint256 w = wallet.withdrawable();
            vm.startPrank(alice);
            if (w != 0) wallet.withdraw(address(usdg), alice, 1 + x % w);
            uint256 over = wallet.withdrawable() + 1;
            vm.expectRevert(AgentWalletV2.LienOwed.selector);
            wallet.withdraw(address(usdg), alice, over);
            vm.stopPrank();
        } else if (op == 8 && lienOn) {
            wallet.settleLien();
        } else if (op == 9) {
            vm.warp(block.timestamp + 9 hours);
            if (wallet.pendingAt() == 0) wallet.requestCheckpoint();
            else if (block.timestamp >= wallet.pendingAt() + 1 days) wallet.takeCheckpoint();
        } else if (op == 10 && lienOn) {
            vm.prank(alice);
            try wallet.endLien() {
                assertTrue(fzCap != 0);
                assertEq(usdg.balanceOf(lender), fzCap);
                lienOn = false;
            } catch {}
        }
    }

    function _fzSum() internal view returns (uint256 sum) {
        for (uint256 k = 0; k < ids.length; k++) {
            (uint128 a,,) = wallet.holds(ids[k]);
            sum += a;
        }
    }

    function testFuzz_rv2_held_books(uint16 bps, uint128 cap, uint256 seed) public {
        bps = uint16(bound(bps, 1, 10_000));
        cap = uint128(bound(cap, 0, 20e6));
        fzCap = cap;
        lienOn = true;
        vm.prank(alice);
        wallet.setLimits(2e6, 6e6);
        usdg.mint(address(wallet), bound(seed, 0, 5e6));
        vm.prank(alice);
        wallet.setLien(lender, bps, cap);
        uint256 base = wallet.profit();
        uint256 peak = base;

        for (uint256 i = 0; i < 40; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            _fzStep(seed, bytes32(i + 1));
            uint256 p = wallet.profit();
            if (p > peak) peak = p;
            assertEq(_fzSum(), wallet.heldTotal(), "heldTotal drifted");
            assertGe(usdg.balanceOf(address(wallet)), wallet.heldTotal() + wallet.parkedTotal(), "holds not covered");
            assertLe(wallet.spentOnDay(_today()), 6e6, "day cap passed");
            assertLe(usdg.balanceOf(lender) * 10_000, (peak - base) * bps, "payee over bps");
            if (cap != 0) assertLe(usdg.balanceOf(lender), cap);
        }
    }

    // =====================================================================
    // THE SCOPED ERC-1271: WHAT HELD
    // =====================================================================

    function _blob(uint256 key, uint256 agentId, uint256 deadline, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encode(agentId, deadline, abi.encodePacked(r, s, v));
    }

    /// The whole path through a registry that behaves as described.
    function test_rv2_held_registry_flow_and_other_peoples_identities() public {
        uint256 mine = registry.mint(alice);
        uint256 bobs = registry.mint(bob);
        uint256 deadline = block.timestamp + 300;
        bytes32 d = registry.digestFor(mine, address(wallet), alice, deadline);
        bytes memory blob = _blob(aliceKey, mine, deadline, d);
        vm.prank(alice);
        registry.setAgentWallet(mine, address(wallet), deadline, blob);
        assertEq(registry.agentWallet(mine), address(wallet));

        // Bob cannot name alice's wallet as HIS agent's wallet: not with her old blob ...
        vm.prank(bob);
        vm.expectRevert("bad wallet signature");
        registry.setAgentWallet(bobs, address(wallet), deadline, blob);
        // ... and not with his own signature over the right digest for his identity
        bytes32 db = registry.digestFor(bobs, address(wallet), bob, deadline);
        vm.prank(bob);
        vm.expectRevert("bad wallet signature");
        registry.setAgentWallet(bobs, address(wallet), deadline, _blob(bobKey, bobs, deadline, db));
        // and alice cannot touch bob's identity at all (the registry's own check)
        vm.prank(alice);
        vm.expectRevert("not owner");
        registry.setAgentWallet(bobs, address(wallet), deadline, blob);
    }

    /// Every way of bending a good signature, and every other statement.
    function test_rv2_held_no_variant_of_a_good_signature_is_accepted() public {
        uint256 id = 7;
        uint256 dl = 999;
        bytes32 d = registry.digestFor(id, address(wallet), alice, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, d);
        assertEq(wallet.isValidSignature(d, abi.encode(id, dl, abi.encodePacked(r, s, v))), bytes4(0x1626ba7e));

        // the mirror-image signature (high s, flipped v) recovers alice too, and is refused
        uint256 nOrder = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s2 = bytes32(nOrder - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        assertEq(ecrecover(d, v2, r, s2), alice);
        assertEq(wallet.isValidSignature(d, abi.encode(id, dl, abi.encodePacked(r, s2, v2))), bytes4(0xffffffff));
        // v as 0/1, garbage v, zeroed signature, 64 and 66 byte signatures
        assertEq(wallet.isValidSignature(d, abi.encode(id, dl, abi.encodePacked(r, s, uint8(v - 27)))), bytes4(0xffffffff));
        assertEq(wallet.isValidSignature(d, abi.encode(id, dl, abi.encodePacked(r, s, uint8(99)))), bytes4(0xffffffff));
        assertEq(wallet.isValidSignature(d, abi.encode(id, dl, new bytes(65))), bytes4(0xffffffff));
        assertEq(wallet.isValidSignature(d, abi.encode(id, dl, abi.encodePacked(r, s))), bytes4(0xffffffff));
        assertEq(wallet.isValidSignature(d, abi.encode(id, dl, abi.encodePacked(r, s, v, uint8(0)))), bytes4(0xffffffff));
    }

    function _check(bytes32 d, bytes memory blob) internal view returns (bool) {
        return wallet.isValidSignature(d, blob) == 0x1626ba7e;
    }

    /// Another chain, another wallet of the same owner, and the bare implementation.
    function test_rv2_held_other_chain_other_wallet_and_implementation_are_refused() public {
        bytes32 d = registry.digestFor(7, address(wallet), alice, 999);
        bytes memory blob = _blob(aliceKey, 7, 999, d);
        assertTrue(_check(d, blob));
        vm.chainId(1);
        assertFalse(_check(d, blob));
        vm.chainId(31337);
        (, address w2) = factory.createAgent(alice, 1, 1, "s2", "", treasury, 2_000);
        bytes32 dOther = registry.digestFor(7, w2, alice, 999);
        assertFalse(_check(dOther, _blob(aliceKey, 7, 999, dOther)));
        assertFalse(AgentWalletV2(w2).isValidSignature(d, blob) == 0x1626ba7e);
        (bool ok, bytes memory ret) =
            factory.walletImplementation().staticcall(abi.encodeCall(I1271.isValidSignature, (d, blob)));
        assertTrue(!ok || abi.decode(ret, (bytes4)) != 0x1626ba7e);
    }

    /// No digest but the one statement is ever confirmed, whatever alice signs.
    function testFuzz_rv2_held_only_the_one_digest(bytes32 digest, uint256 id, uint256 dl) public view {
        vm.assume(digest != registry.digestFor(id, address(wallet), alice, dl));
        assertEq(wallet.isValidSignature(digest, _blob(aliceKey, id, dl, digest)), bytes4(0xffffffff));
    }

    /// Worst case for money: a USDG that honours ERC-1271 for contract senders.
    /// Neither a registry confirmation replayed at the token, nor alice's own
    /// signature over the token's digest, moves the wallet's money.
    function test_rv2_held_confirmation_cannot_authorise_a_usdg_transfer() public {
        usdg.mint(address(wallet), 10e6);
        uint256 id = registry.mint(alice);
        bytes32 d = registry.digestFor(id, address(wallet), alice, 999);
        bytes memory good = _blob(aliceKey, id, 999, d);
        vm.expectRevert("bad signature");
        usdg.transferWithContractAuthorization(address(wallet), mallory, 10e6, "n", good);

        bytes32 td = usdg.authDigest(address(wallet), alice, 10e6, "n");
        vm.expectRevert("bad signature");
        usdg.transferWithContractAuthorization(address(wallet), alice, 10e6, "n", _blob(aliceKey, id, 999, td));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, td);
        vm.expectRevert(); // a bare 65-byte signature does not even decode
        usdg.transferWithContractAuthorization(address(wallet), alice, 10e6, "n", abi.encodePacked(r, s, v));
        assertEq(usdg.balanceOf(address(wallet)), 10e6);
    }

    /// The previous owner's signature dies with the handover, in the registry flow too.
    function test_rv2_held_old_owner_signature_dies_on_handover() public {
        uint256 id = registry.mint(alice);
        uint256 dl = block.timestamp + 300;
        bytes32 d = registry.digestFor(id, address(wallet), alice, dl);
        bytes memory blob = _blob(aliceKey, id, dl, d);
        vm.prank(alice);
        wallet.transferOwnership(bob);
        vm.prank(bob);
        wallet.acceptOwnership();
        vm.prank(alice); // still owns the identity, no longer the wallet
        vm.expectRevert("bad wallet signature");
        registry.setAgentWallet(id, address(wallet), dl, blob);
    }
}
