// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactory} from "../src/ZeroLuxFactory.sol";
import {AgentWallet} from "../src/AgentWallet.sol";

/// Independent review tests. Each test DEMONSTRATES a behaviour (it passes when
/// the behaviour described in its name is real).

contract RToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public frozen;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function freeze(address who, bool on) external {
        frozen[who] = on;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!frozen[msg.sender] && !frozen[to], "frozen");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FalseToken {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// Token that tries to re-enter the wallet during transfer.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    AgentWallet public target;
    bytes public payload;
    bool public reentryOk;
    bool public tried;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(AgentWallet t, bytes calldata p) external {
        target = t;
        payload = p;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (address(target) != address(0) && !tried) {
            tried = true;
            (reentryOk,) = address(target).call(payload);
        }
        return true;
    }
}

/// An attacker-run "factory": same view surface the wallet reads.
contract FakeFactory {
    address public operator;
    address public treasury;
    uint16 public markupBps;
    address public usdg;

    constructor(address usdg_) {
        operator = msg.sender;
        treasury = msg.sender;
        usdg = usdg_;
    }

    function set(address usdg_) external {
        usdg = usdg_;
    }

    function initWallet(address w, address owner_, uint128 a, uint128 b) external {
        AgentWallet(w).init(owner_, a, b);
    }

    /// Same EIP-1167 creation code as the real factory.
    function cloneOf(address implementation, bytes32 salt) external returns (address instance) {
        assembly {
            mstore(0x00, or(shr(0xe8, shl(0x60, implementation)), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000))
            mstore(0x20, or(shl(0x78, implementation), 0x5af43d82803e903d91602b57fd5bf3))
            instance := create2(0, 0x09, 0x37, salt)
        }
    }
}

contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

contract ReviewTest is Test {
    RToken usdg;
    ZeroLuxFactory factory;
    AgentWallet wallet;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address mallory = makeAddr("mallory");

    uint128 constant RUN_CAP = 1e6;
    uint128 constant DAY_CAP = 5e6;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new RToken();
        factory = new ZeroLuxFactory(address(usdg), admin, operator, treasury, 2_000);
        (, address w) = factory.createAgent(alice, RUN_CAP, DAY_CAP, keccak256("spec"));
        wallet = AgentWallet(w);
        usdg.mint(w, 100e6);
    }

    function _drainDay(AgentWallet w, uint256 tag) internal returns (uint256 moved) {
        uint256 n;
        while (true) {
            uint256 left = w.remainingToday();
            if (left == 0) break;
            uint256 total = left > w.perRunCap() ? w.perRunCap() : left;
            // cost such that cost + fee <= total
            uint256 cost = (total * 10_000) / (10_000 + w.markupBps());
            if (cost == 0) break;
            try w.charge(keccak256(abi.encode(tag, ++n)), cost) {
                moved += cost + (cost * w.markupBps()) / 10_000;
            } catch {
                break;
            }
        }
    }

    // ------------------------------------------------------------------
    // Clone bytecode
    // ------------------------------------------------------------------

    function test_review_clone_runtime_is_standard_eip1167() public view {
        address impl = factory.walletImplementation();
        bytes memory expected =
            abi.encodePacked(hex"363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3");
        assertEq(expected.length, 45);
        assertEq(address(wallet).code, expected, "runtime is not the standard 45-byte proxy");
        assertEq(address(wallet).code.length, 45);
    }

    function test_review_clone_address_matches_standard_initcode() public {
        address impl = factory.walletImplementation();
        // Standard EIP-1167 creation code: 10-byte constructor + 45-byte runtime = 55 bytes.
        bytes memory initcode =
            abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3");
        assertEq(initcode.length, 55);
        // setUp's wallet: this contract's creation number 0.
        assertEq(address(wallet), _predict(address(this), 0, initcode));
        assertEq(factory.createdBy(address(this)), 1);
        (, address w) = factory.createAgent(alice, 1, 1, bytes32(0));
        assertEq(w, _predict(address(this), 1, initcode), "initcode differs from the standard one");
    }

    function _predict(address creator, uint256 n, bytes memory initcode) internal view returns (address) {
        bytes32 salt = keccak256(abi.encode(creator, n));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, keccak256(initcode)))))
        );
    }

    /// The constructor lock lives in the implementation's own storage: the
    /// implementation can no longer be initialised, clones still can (once).
    function test_review_implementation_is_locked_and_clones_are_not() public {
        AgentWallet impl = AgentWallet(factory.walletImplementation());
        assertEq(impl.factory(), address(1));
        assertEq(impl.owner(), address(0));
        FakeFactory fake = new FakeFactory(address(usdg));
        vm.expectRevert(AgentWallet.AlreadyInitialised.selector);
        fake.initWallet(address(impl), mallory, 1, 1);
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.AlreadyInitialised.selector);
        impl.init(mallory, 1, 1);
        // Nobody is operator or owner of the implementation.
        vm.prank(mallory);
        vm.expectRevert();
        impl.charge("x", 1);
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        impl.adoptTerms(address(0), 0);
        // A fresh clone from the real factory starts unlocked and is initialised in the same call.
        (, address w) = factory.createAgent(alice, RUN_CAP, DAY_CAP, bytes32(0));
        assertEq(AgentWallet(w).factory(), address(factory));
        assertEq(AgentWallet(w).treasury(), treasury);
        assertEq(AgentWallet(w).markupBps(), 2_000);
    }

    // ------------------------------------------------------------------
    // Stolen factory-owner key
    // ------------------------------------------------------------------

    /// FIXED (was H1). The thief still takes sole ownership in one block and
    /// still becomes the factory treasury after two days, but existing wallets
    /// keep paying the treasury and markup they were created with.
    function test_review_stolen_owner_key_never_receives_from_existing_wallets() public {
        address bob = makeAddr("bob");
        (, address w2) = factory.createAgent(bob, RUN_CAP, DAY_CAP, bytes32(0));
        usdg.mint(w2, 100e6);

        vm.prank(admin); // stolen key
        factory.transferOwnership(mallory);
        vm.startPrank(mallory);
        factory.acceptOwnership();
        factory.proposeTreasury(mallory);
        factory.setOperator(mallory);
        factory.setMarkup(5_000);
        vm.stopPrank();

        // STILL TRUE: the real team is locked out for good (no delay on the handover).
        vm.startPrank(admin);
        vm.expectRevert(ZeroLuxFactory.NotOwner.selector);
        factory.setOperator(operator);
        vm.expectRevert(ZeroLuxFactory.NotOwner.selector);
        factory.transferOwnership(admin);
        vm.stopPrank();

        uint256 midnight = ((block.timestamp + 2 days) / 1 days + 1) * 1 days;
        vm.warp(midnight - 1);
        vm.startPrank(mallory);
        factory.acceptTreasury();
        assertEq(factory.treasury(), mallory);
        uint256 moved;
        moved += _drainDay(wallet, 1);
        moved += _drainDay(AgentWallet(w2), 2);
        vm.warp(midnight);
        moved += _drainDay(wallet, 3);
        moved += _drainDay(AgentWallet(w2), 4);
        vm.stopPrank();

        assertEq(usdg.balanceOf(mallory), 0); // the thief gets nothing
        assertEq(usdg.balanceOf(treasury), moved); // forced charges land in the ORIGINAL treasury
        assertEq(wallet.treasury(), treasury);
        assertEq(wallet.markupBps(), 2_000); // at the ORIGINAL markup
        assertEq(AgentWallet(w2).markupBps(), 2_000);

        // Wallets created AFTER the switch do pay the thief, at the thief's markup.
        (, address w3) = factory.createAgent(bob, RUN_CAP, DAY_CAP, bytes32(0));
        assertEq(AgentWallet(w3).treasury(), mallory);
        assertEq(AgentWallet(w3).markupBps(), 5_000);
    }

    /// STILL OPEN (was M1). The operator is read live, so a stolen owner key can
    /// at once push every wallet's day cap into the wallet's own (original)
    /// treasury, at the wallet's own markup, with no run having happened.
    function test_review_stolen_owner_key_instant_forced_charges_to_original_treasury() public {
        vm.startPrank(admin); // stolen key
        factory.setOperator(mallory);
        factory.setMarkup(5_000); // no effect on this wallet any more
        vm.stopPrank();
        vm.startPrank(mallory);
        uint256 moved = _drainDay(wallet, 1);
        vm.stopPrank();
        assertGt(moved, uint256(DAY_CAP) - 10);
        assertEq(usdg.balanceOf(treasury), moved);
        assertEq(usdg.balanceOf(mallory), 0);
        assertEq(wallet.markupBps(), 2_000);
    }

    // ------------------------------------------------------------------
    // NEW, MEDIUM: adoptTerms() is blind
    // ------------------------------------------------------------------

    /// adoptTerms() takes no arguments, so the owner signs "whatever the
    /// factory says when my transaction lands". A stolen factory-owner key
    /// front-runs it with setMarkup(50%): the owner meant to adopt 10%.
    function test_review_adoptTerms_frontrun_cannot_swap_the_markup() public {
        vm.prank(admin);
        factory.setMarkup(1_000); // announced: fee drops to 10%, "please adopt"
        vm.prank(admin);
        factory.setMarkup(5_000); // the stolen key gets in first
        vm.prank(alice);
        vm.expectRevert(AgentWallet.TermsChanged.selector);
        wallet.adoptTerms(treasury, 1_000);
        assertEq(wallet.markupBps(), 2_000); // unchanged
    }

    /// Same hole, the expensive way round: once the thief is the factory
    /// treasury (2 days), ANY adoptTerms() call re-opens the original H1 for
    /// that wallet, and the call gives the owner no way to say which treasury
    /// she meant.
    function test_review_adoptTerms_after_takeover_does_not_hand_wallet_to_thief() public {
        vm.prank(admin); // stolen key
        factory.transferOwnership(mallory);
        vm.startPrank(mallory);
        factory.acceptOwnership();
        factory.proposeTreasury(mallory);
        factory.setOperator(mallory);
        vm.warp(block.timestamp + 2 days);
        factory.acceptTreasury();
        vm.stopPrank();

        vm.prank(alice); // told "adopt to get the lower fee"; she names the treasury she knows
        vm.expectRevert(AgentWallet.TermsChanged.selector);
        wallet.adoptTerms(treasury, 2_000);
        assertEq(wallet.treasury(), treasury);

        vm.startPrank(mallory);
        _drainDay(wallet, 1);
        vm.stopPrank();
        assertEq(usdg.balanceOf(mallory), 0);
    }

    // ------------------------------------------------------------------
    // NEW, LOW: the pinned treasury cannot be rotated by the team
    // ------------------------------------------------------------------

    /// If the original treasury is frozen (or its key is lost or stolen), the
    /// team's own treasury change no longer reaches existing wallets: charges
    /// keep failing (or keep paying the dead address) until each owner adopts.
    function test_review_treasury_rotation_needs_every_owner_to_adopt() public {
        address next = makeAddr("next");
        usdg.freeze(treasury, true);
        vm.startPrank(admin);
        factory.proposeTreasury(next);
        vm.warp(block.timestamp + 2 days);
        factory.acceptTreasury();
        vm.stopPrank();

        vm.prank(operator);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.charge("r", 100_000); // still pinned to the frozen address

        {

            address t_ = factory.treasury();

            uint16 m_ = factory.markupBps();

            vm.prank(alice);

            wallet.adoptTerms(t_, m_);

        }
        vm.prank(operator);
        wallet.charge("r", 100_000);
        assertEq(usdg.balanceOf(next), 120_000);
    }

    // ------------------------------------------------------------------
    // MEDIUM: the wallet owner can always dodge the charge for a finished run
    // ------------------------------------------------------------------

    function test_review_owner_frontruns_charge_and_gets_the_run_free() public {
        // The run has happened off chain; the meter's charge is in the mempool.
        // Alice (a hostile agent owner) gets in first.
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 100e6);
        vm.prank(operator);
        vm.expectRevert();
        wallet.charge("run1", 500_000);
        assertEq(usdg.balanceOf(treasury), 0);

        // Same result without even moving the money.
        usdg.mint(address(wallet), 100e6);
        vm.prank(alice);
        wallet.setLimits(0, 0);
        vm.prank(operator);
        vm.expectRevert(AgentWallet.OverRunCap.selector);
        wallet.charge("run1", 500_000);
        vm.prank(alice);
        wallet.setLimits(RUN_CAP, DAY_CAP);
        vm.prank(alice);
        wallet.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(AgentWallet.Paused.selector);
        wallet.charge("run1", 500_000);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    // ------------------------------------------------------------------
    // LOW: day boundary
    // ------------------------------------------------------------------

    function test_review_day_boundary_allows_two_day_caps_in_one_second() public {
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(midnight - 1);
        vm.startPrank(operator);
        uint256 a = _drainDay(wallet, 1);
        vm.warp(midnight);
        uint256 b = _drainDay(wallet, 2);
        vm.stopPrank();
        assertGt(a + b, 2 * uint256(DAY_CAP) - 20);
        assertEq(usdg.balanceOf(treasury), a + b);
    }

    // ------------------------------------------------------------------
    // LOW: lookalike wallet under an attacker's factory
    // ------------------------------------------------------------------

    /// Anyone can clone the same implementation and initialise it under their
    /// own "factory". On chain it is byte-identical to a real agent wallet and
    /// reports the victim as owner, but its operator/treasury are the attacker.
    /// factory.isAgentWallet() is the only thing that tells them apart.
    function test_review_lookalike_wallet_trusts_attacker_factory() public {
        vm.startPrank(mallory);
        FakeFactory fake = new FakeFactory(address(usdg));
        address look = fake.cloneOf(factory.walletImplementation(), bytes32(uint256(1)));
        fake.initWallet(look, alice, type(uint128).max, type(uint128).max);
        vm.stopPrank();

        assertEq(look.code, address(wallet).code); // indistinguishable bytecode
        assertEq(AgentWallet(look).owner(), alice);
        assertFalse(factory.isAgentWallet(look)); // the only discriminator

        usdg.mint(look, 50e6); // a customer pays the lookalike
        vm.prank(mallory);
        AgentWallet(look).charge("x", 50e6);
        assertEq(usdg.balanceOf(mallory), 50e6);
    }

    // ------------------------------------------------------------------
    // Wallet address prediction
    // ------------------------------------------------------------------

    /// FIXED (was L3). The address depends only on the creator and the
    /// creator's own count, so nobody else can shift it and a pre-funded
    /// address is reached by the creator's next createAgent.
    function test_review_predicted_wallet_address_cannot_be_shifted_by_others() public {
        bytes memory initcode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            factory.walletImplementation(),
            hex"5af43d82803e903d91602b57fd5bf3"
        );
        address predicted = _predict(alice, factory.createdBy(alice), initcode);
        usdg.mint(predicted, 10e6); // paid before it exists

        vm.startPrank(mallory); // tries to shift it
        factory.createAgent(mallory, 0, 0, bytes32(0));
        factory.createAgent(alice, 0, 0, bytes32(0)); // even naming alice as owner
        vm.stopPrank();

        vm.prank(alice);
        (, address w) = factory.createAgent(alice, RUN_CAP, DAY_CAP, bytes32(0));
        assertEq(w, predicted);
        vm.prank(alice);
        AgentWallet(w).withdraw(address(usdg), alice, 10e6);
        assertEq(usdg.balanceOf(alice), 10e6);
    }

    // ------------------------------------------------------------------
    // INFO: accounting
    // ------------------------------------------------------------------


    function test_review_forced_eth_cannot_be_recovered() public {
        // The wallet has no receive(), so plain sends bounce...
        vm.deal(address(this), 2 ether);
        (bool ok,) = address(wallet).call{value: 1 ether}("");
        assertFalse(ok);
        // ...but forced ether has no way out (withdraw only speaks ERC-20).
        new ForceSend{value: 1 ether}(payable(address(wallet)));
        assertEq(address(wallet).balance, 1 ether);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.withdraw(address(0), alice, 1 ether);
    }

    // ------------------------------------------------------------------
    // Things that HOLD (coverage the original suite lacks)
    // ------------------------------------------------------------------

    function test_review_frozen_treasury_blocks_charges_but_not_withdrawals() public {
        usdg.freeze(treasury, true);
        vm.prank(operator);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.charge("r", 100_000);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 100e6);
        assertEq(usdg.balanceOf(alice), 100e6);
    }

    function test_review_failed_charge_does_not_burn_runId_or_day_budget() public {
        usdg.freeze(treasury, true);
        vm.prank(operator);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.charge("r", 100_000);
        assertFalse(wallet.runCharged("r"));
        assertEq(wallet.remainingToday(), DAY_CAP);
        assertEq(wallet.totalCharged(), 0);
    }

    function test_review_send_handles_false_noreturn_and_codeless_tokens() public {
        FalseToken ft = new FalseToken();
        NoReturnToken nr = new NoReturnToken();
        nr.mint(address(wallet), 7);
        vm.startPrank(alice);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.withdraw(address(ft), alice, 1);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.withdraw(makeAddr("eoa"), alice, 1);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.withdraw(address(1), alice, 1); // ecrecover precompile
        // Identity precompile echoes the calldata: abi.decode(bool) rejects it, so the
        // revert carries no data (not TransferFailed). Still a revert.
        vm.expectRevert(bytes(""));
        wallet.withdraw(address(4), alice, 1);
        wallet.withdraw(address(nr), alice, 7);
        vm.stopPrank();
        assertEq(nr.balanceOf(alice), 7);
    }

    function test_review_reentrancy_through_token_cannot_exceed_caps() public {
        ReentrantToken rt = new ReentrantToken();
        ZeroLuxFactory f2 = new ZeroLuxFactory(address(rt), admin, address(rt), treasury, 0);
        (, address w) = f2.createAgent(alice, RUN_CAP, RUN_CAP, bytes32(0));
        rt.mint(w, 100e6);
        // The token itself is the operator here (worst case) and re-enters charge().
        rt.arm(AgentWallet(w), abi.encodeCall(AgentWallet.charge, ("second", uint256(RUN_CAP))));
        vm.prank(address(rt));
        AgentWallet(w).charge("first", RUN_CAP);
        assertTrue(rt.tried());
        assertFalse(rt.reentryOk()); // nested charge hit OverDayCap: state was written before the call
        assertEq(rt.balanceOf(treasury), RUN_CAP);
    }

    function test_review_init_cannot_be_reached_after_creation_and_zero_owner_reverts() public {
        vm.expectRevert(AgentWallet.ZeroAddress.selector);
        factory.createAgent(address(0), 1, 1, bytes32(0));
        assertEq(factory.agentCount(), 1); // nothing registered by the failed call
        vm.prank(address(factory));
        vm.expectRevert(AgentWallet.AlreadyInitialised.selector);
        wallet.init(mallory, 1, 1);
    }

    function test_review_ownership_edge_cases() public {
        // Offering to zero just clears the offer; nobody can accept as zero.
        vm.prank(alice);
        wallet.transferOwnership(address(0));
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.acceptOwnership();
        // A pending offer that is never accepted leaves the owner in full control, and can be replaced.
        vm.startPrank(alice);
        wallet.transferOwnership(mallory);
        wallet.transferOwnership(address(0));
        wallet.withdraw(address(usdg), alice, 1);
        vm.stopPrank();
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.acceptOwnership();
        // Old owner loses everything on accept.
        address bob = makeAddr("bob");
        vm.prank(alice);
        wallet.transferOwnership(bob);
        vm.prank(bob);
        wallet.acceptOwnership();
        vm.prank(alice);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.withdraw(address(usdg), alice, 1);
    }

    function test_review_reproposing_treasury_restarts_the_clock() public {
        vm.startPrank(admin);
        factory.proposeTreasury(makeAddr("a"));
        vm.warp(block.timestamp + 2 days - 1);
        factory.proposeTreasury(mallory); // swap the target at the last second
        vm.warp(block.timestamp + 1);
        vm.expectRevert(ZeroLuxFactory.TooEarly.selector);
        factory.acceptTreasury();
        vm.stopPrank();
    }

    function test_review_huge_cost_reverts_not_wraps() public {
        vm.prank(alice);
        wallet.setLimits(type(uint128).max, type(uint128).max);
        vm.startPrank(operator);
        vm.expectRevert(); // arithmetic overflow in cost * markup
        wallet.charge("a", type(uint256).max);
        vm.expectRevert(AgentWallet.OverRunCap.selector);
        wallet.charge("b", uint256(type(uint128).max));
        vm.stopPrank();
    }

    /// Day spend never exceeds the cap whatever the operator, a markup-flipping admin and an adopting owner do.
    function testFuzz_review_day_cap_holds_under_markup_changes(uint256 seed) public {
        uint256 day = block.timestamp / 1 days;
        for (uint256 i; i < 40; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.prank(admin);
            factory.setMarkup(uint16(seed % 5_001));
            if (seed & (1 << 200) != 0) {
                {
                    address t_ = factory.treasury();
                    uint16 m_ = factory.markupBps();
                    vm.prank(alice);
                    wallet.adoptTerms(t_, m_);
                }
            }
            uint256 cost = (seed >> 16) % 1_200_000 + 1;
            vm.prank(operator);
            try wallet.charge(bytes32(seed), cost) {} catch {}
        }
        assertLe(wallet.spentOnDay(day), DAY_CAP);
        assertEq(wallet.totalCharged(), wallet.spentOnDay(day));
        assertEq(usdg.balanceOf(treasury), wallet.totalCharged());
        assertEq(usdg.balanceOf(address(wallet)), 100e6 - wallet.totalCharged());
        assertEq(wallet.remainingToday(), DAY_CAP - wallet.spentOnDay(day));
    }
}
