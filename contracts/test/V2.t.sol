// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactoryV2} from "../src/ZeroLuxFactoryV2.sol";
import {AgentWalletV2} from "../src/AgentWalletV2.sol";
import {ZeroLuxTreasury} from "../src/ZeroLuxTreasury.sol";

/// USDG stand-in with the one behaviour that matters here: a used authorization
/// is accepted again and moves nothing (as the real token does).
contract MockUSDG3009 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferWithAuthorization(
        address from, address to, uint256 value, uint256, uint256 validBefore, bytes32 nonce, uint8 v, bytes32, bytes32
    ) external {
        require(block.timestamp < validBefore, "expired");
        require(v == 27, "bad signature"); // tests use v = 27 for "good" and anything else for "bad"
        if (authorizationState[from][nonce]) return; // replay: no revert, no movement
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

contract V2Test is Test {
    MockUSDG3009 usdg;
    ZeroLuxFactoryV2 factory;
    AgentWalletV2 wallet;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    uint256 aliceKey = 0xA11CE;
    address alice;
    address customer = makeAddr("customer");
    address lender = makeAddr("lender");
    address mallory = makeAddr("mallory");

    uint128 constant RUN_CAP = 1e6; // $1 a run, fee included
    uint128 constant DAY_CAP = 5e6;

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = vm.addr(aliceKey);
        usdg = new MockUSDG3009();
        factory = new ZeroLuxFactoryV2(address(usdg), admin, operator, treasury, 2_000, address(0));
        (, address w) = factory.createAgent(alice, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_000);
        wallet = AgentWalletV2(w);
        usdg.mint(customer, 100e6);
    }

    function _pay(bytes32 nonce, uint256 value, bytes32 runId, uint256 budget) internal {
        vm.prank(operator);
        wallet.pay(customer, value, 0, block.timestamp + 600, nonce, 27, bytes32(0), bytes32(0), runId, budget);
    }

    // ---- pay: take the payment and set the run's cost aside in one step ----

    function test_pay_takes_the_payment_and_holds_the_runs_maximum_cost() public {
        _pay("n1", 1e6, "r1", 800_000); // $1 paid; up to $0.80 of cost, $0.96 with the fee
        assertEq(usdg.balanceOf(address(wallet)), 1e6);
        assertEq(usdg.balanceOf(customer), 99e6);
        (uint128 held,,) = wallet.holds("r1");
        assertEq(held, 960_000);
        assertEq(wallet.heldTotal(), 960_000);
        assertEq(wallet.withdrawable(), 40_000, "the owner can take only what is not set aside");
    }

    function test_only_the_operator_can_pay_or_open() public {
        vm.expectRevert(AgentWalletV2.NotOperator.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 1);
        vm.prank(alice);
        vm.expectRevert(AgentWalletV2.NotOperator.selector);
        wallet.open("r1", 1);
    }

    function test_a_used_payment_is_refused_because_no_money_arrived() public {
        _pay("n1", 1e6, "r1", 100_000);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotPaid.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r2", 100_000);
        assertEq(usdg.balanceOf(customer), 99e6);
    }

    function test_a_bad_signature_is_refused() public {
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotPaid.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 28, bytes32(0), bytes32(0), "r1", 100_000);
    }

    function test_customer_is_not_charged_when_the_wallet_cannot_take_the_run() public {
        vm.prank(alice);
        wallet.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.Paused.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 100_000);
        assertEq(usdg.balanceOf(customer), 100e6, "the whole transaction is undone");
        assertFalse(usdg.authorizationState(customer, "n1"), "and the payment can still be used later");

        vm.prank(alice);
        wallet.setPaused(false);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.OverRunCap.selector); // $0.90 + 20% is over the $1 run limit
        wallet.pay(customer, 2e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 900_000);
        assertEq(usdg.balanceOf(customer), 100e6);
    }

    function test_holds_count_against_the_day_limit_when_opened() public {
        for (uint256 i = 0; i < 5; i++) {
            _pay(bytes32(i + 1), 1e6, bytes32(i + 100), 833_333); // 833,333 + 20% = 999,999
        }
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.OverDayCap.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n9", 27, bytes32(0), bytes32(0), "r9", 833_333);
    }

    function test_the_same_run_cannot_be_opened_twice() public {
        _pay("n1", 1e6, "r1", 100_000);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.RunAlreadyCharged.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n2", 27, bytes32(0), bytes32(0), "r1", 100_000);
    }

    // ---- open: for a payment that arrived some other way ----

    function test_open_sets_aside_only_money_that_is_free() public {
        usdg.mint(address(wallet), 500_000);
        vm.startPrank(operator);
        wallet.open("r1", 300_000); // holds $0.36
        vm.expectRevert(AgentWalletV2.TransferFailed.selector);
        wallet.open("r2", 300_000); // only $0.14 is free
        wallet.open("r3", 100_000); // $0.12 fits
        vm.stopPrank();
        assertEq(wallet.heldTotal(), 480_000);
    }

    function test_open_fails_if_the_owner_already_took_the_money() public {
        usdg.mint(address(wallet), 500_000);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 500_000);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.TransferFailed.selector);
        wallet.open("r1", 100_000);
    }

    // ---- charge: an open run can always be billed ----

    function test_nothing_can_be_charged_that_was_not_set_aside() public {
        usdg.mint(address(wallet), 5e6);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotOpen.selector);
        wallet.charge("r1", 100_000);
    }

    function test_charge_pays_the_treasury_and_frees_the_rest_of_the_hold() public {
        _pay("n1", 1e6, "r1", 800_000);
        vm.prank(operator);
        wallet.charge("r1", 100_000); // $0.12 with the fee
        assertEq(usdg.balanceOf(treasury), 120_000);
        assertEq(wallet.heldTotal(), 0);
        assertEq(wallet.withdrawable(), 880_000);
        assertEq(wallet.remainingToday(), DAY_CAP - 120_000, "only what was charged counts against the day");
        assertTrue(wallet.runCharged("r1"));
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotOpen.selector);
        wallet.charge("r1", 1);
    }

    function test_charge_cannot_exceed_what_was_set_aside() public {
        _pay("n1", 1e6, "r1", 100_000);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.OverRunCap.selector);
        wallet.charge("r1", 100_001);
    }

    function test_owner_cannot_stop_an_open_run_being_billed() public {
        _pay("n1", 1e6, "r1", 800_000);
        // the owner tries everything
        vm.startPrank(alice);
        wallet.setPaused(true);
        wallet.setLimits(0, 0);
        vm.expectRevert(AgentWalletV2.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 40_001);
        wallet.withdraw(address(usdg), alice, 40_000); // everything that is not set aside
        vm.stopPrank();
        vm.prank(operator);
        wallet.charge("r1", 800_000);
        assertEq(usdg.balanceOf(treasury), 960_000, "the run is billed in full regardless");
    }

    function test_two_runs_in_flight_are_both_covered() public {
        _pay("n1", 1e6, "r1", 500_000);
        _pay("n2", 1e6, "r2", 500_000);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 800_000);
        vm.startPrank(operator);
        wallet.charge("r2", 500_000);
        wallet.charge("r1", 500_000);
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 1_200_000);
        assertEq(usdg.balanceOf(address(wallet)), 0);
    }

    function test_a_charge_on_a_later_day_gives_back_the_day_it_was_opened_on() public {
        _pay("n1", 1e6, "r1", 800_000);
        uint256 openedDay = block.timestamp / 1 days;
        vm.warp(block.timestamp + 20 hours); // past midnight UTC
        vm.prank(operator);
        wallet.charge("r1", 100_000);
        assertEq(wallet.spentOnDay(openedDay), 120_000);
        assertEq(wallet.spentOnDay(block.timestamp / 1 days), 0);
    }

    // ---- release ----

    function test_operator_can_release_a_hold_and_the_day_limit_comes_back() public {
        _pay("n1", 1e6, "r1", 800_000);
        vm.prank(operator);
        wallet.release("r1");
        assertEq(wallet.heldTotal(), 0);
        assertEq(wallet.withdrawable(), 1e6);
        assertEq(wallet.remainingToday(), DAY_CAP);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotOpen.selector);
        wallet.charge("r1", 1);
    }

    function test_nobody_else_can_release_a_fresh_hold_but_anyone_can_after_a_day() public {
        _pay("n1", 1e6, "r1", 800_000);
        vm.prank(alice);
        vm.expectRevert(AgentWalletV2.HoldStands.selector);
        wallet.release("r1");
        vm.warp(block.timestamp + 1 days);
        vm.prank(mallory);
        wallet.release("r1");
        assertEq(wallet.withdrawable(), 1e6, "an abandoned hold cannot lock the owner's money for good");
    }

    function test_releasing_nothing_reverts() public {
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotOpen.selector);
        wallet.release("nope");
    }

    // ---- holds and a profit pledge together ----

    function test_a_pledge_is_never_paid_from_money_set_aside_for_a_run() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0); // all profit pledged
        usdg.mint(address(wallet), 1e6);
        vm.prank(operator);
        wallet.settle(type(uint256).max); // $1 of settled profit, all owed to the lender
        _pay("n1", 1e6, "r1", 800_000); // a new run comes in and $0.96 is set aside
        assertEq(wallet.settleLien(), 1e6, "the lender gets the settled dollar");
        assertEq(usdg.balanceOf(address(wallet)), 1e6);
        assertEq(wallet.settleLien(), 0, "and nothing from the held run");
        vm.prank(operator);
        wallet.chargeAndSettle("r1", 800_000, type(uint256).max);
        assertEq(usdg.balanceOf(treasury), 960_000);
        assertEq(wallet.settleLien(), 40_000, "then the run's real profit");
    }

    function testFuzz_books_balance_and_holds_are_always_covered(uint64[8] memory pays, uint64[8] memory costs, uint8[8] memory acts)
        public
    {
        vm.prank(alice);
        wallet.setLimits(type(uint128).max, type(uint128).max);
        for (uint256 i = 0; i < 8; i++) {
            uint256 value = bound(pays[i], 1, 5e6);
            uint256 budget = bound(costs[i], 1, value); // may be more than fits; then it reverts and nothing happens
            bytes32 id = bytes32(i + 1);
            vm.prank(operator);
            try wallet.pay(customer, value, 0, block.timestamp + 600, id, 27, bytes32(0), bytes32(0), id, budget) {} catch {}
            (uint128 held,,) = wallet.holds(id);
            uint256 act = acts[i] % 4;
            if (act == 0 && (uint256(held) * 10_000) / 12_000 != 0) {
                uint256 cost = bound(costs[(i + 1) % 8], 1, (uint256(held) * 10_000) / 12_000);
                vm.prank(operator);
                wallet.charge(id, cost);
            } else if (act == 1 && held != 0) {
                vm.prank(operator);
                wallet.release(id);
            } else if (act == 2) {
                uint256 w = wallet.withdrawable();
                vm.prank(alice);
                wallet.withdraw(address(usdg), alice, w); // always allowed
                vm.prank(alice);
                vm.expectRevert(AgentWalletV2.LienOwed.selector);
                wallet.withdraw(address(usdg), alice, 1); // and not a unit more
            }
            assertGe(usdg.balanceOf(address(wallet)), wallet.heldTotal(), "money set aside is always in the wallet");
        }
        assertEq(
            wallet.income(),
            usdg.balanceOf(treasury) + usdg.balanceOf(alice) + usdg.balanceOf(address(wallet)),
            "every dollar in is with the treasury, the owner or the wallet"
        );
    }

    // ---- the one statement the wallet will confirm ----

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");

    function _walletWithRegistry(address registry) internal returns (AgentWalletV2 w) {
        ZeroLuxFactoryV2 f = new ZeroLuxFactoryV2(address(usdg), admin, operator, treasury, 2_000, registry);
        (, address a) = f.createAgent(alice, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_000);
        w = AgentWalletV2(a);
    }

    function _digest(address registry, uint256 agentId, address newWallet, address owner_, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("ERC8004IdentityRegistry"), keccak256("1"), block.chainid, registry)
        );
        return keccak256(
            abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(SET_TYPEHASH, agentId, newWallet, owner_, deadline)))
        );
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_wallet_confirms_being_named_payment_wallet_when_its_owner_signs() public {
        address registry = makeAddr("registry");
        AgentWalletV2 w = _walletWithRegistry(registry);
        bytes32 d = _digest(registry, 77, address(w), alice, 123);
        assertEq(w.isValidSignature(d, abi.encode(uint256(77), uint256(123), _sig(aliceKey, d))), bytes4(0x1626ba7e));
    }

    function test_wallet_refuses_every_other_statement() public {
        address registry = makeAddr("registry");
        AgentWalletV2 w = _walletWithRegistry(registry);
        bytes32 d = _digest(registry, 77, address(w), alice, 123);
        bytes memory good = _sig(aliceKey, d);
        // someone else's signature
        assertEq(w.isValidSignature(d, abi.encode(uint256(77), uint256(123), _sig(0xB0B, d))), bytes4(0xffffffff));
        // the owner's signature, presented for a different agent or deadline
        assertEq(w.isValidSignature(d, abi.encode(uint256(78), uint256(123), good)), bytes4(0xffffffff));
        assertEq(w.isValidSignature(d, abi.encode(uint256(77), uint256(124), good)), bytes4(0xffffffff));
        // any other digest the owner signed (a transfer, a permit, a message): never valid
        bytes32 other = keccak256("TransferWithAuthorization or anything else");
        assertEq(w.isValidSignature(other, abi.encode(uint256(77), uint256(123), _sig(aliceKey, other))), bytes4(0xffffffff));
        // a statement naming a different wallet, or made for a different registry
        bytes32 d2 = _digest(registry, 77, mallory, alice, 123);
        assertEq(w.isValidSignature(d2, abi.encode(uint256(77), uint256(123), _sig(aliceKey, d2))), bytes4(0xffffffff));
        bytes32 d3 = _digest(makeAddr("other registry"), 77, address(w), alice, 123);
        assertEq(w.isValidSignature(d3, abi.encode(uint256(77), uint256(123), _sig(aliceKey, d3))), bytes4(0xffffffff));
        // a wallet made by a factory with no registry confirms nothing
        bytes32 d4 = _digest(address(0), 77, address(wallet), alice, 123);
        assertEq(wallet.isValidSignature(d4, abi.encode(uint256(77), uint256(123), _sig(aliceKey, d4))), bytes4(0xffffffff));
    }

    function test_a_new_owner_invalidates_the_old_owners_signature() public {
        address registry = makeAddr("registry");
        AgentWalletV2 w = _walletWithRegistry(registry);
        bytes32 d = _digest(registry, 77, address(w), alice, 123);
        bytes memory blob = abi.encode(uint256(77), uint256(123), _sig(aliceKey, d));
        vm.prank(alice);
        w.transferOwnership(mallory);
        vm.prank(mallory);
        w.acceptOwnership();
        assertEq(w.isValidSignature(d, blob), bytes4(0xffffffff));
    }
}

interface IUSDGv2 {
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IRegistryV2 {
    function ownerOf(uint256) external view returns (address);
    function getAgentWallet(uint256) external view returns (address);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
}

/// Against a fork of Robinhood Chain: the real USDG and the real ERC-8004 registry.
///   FORK_RPC_URL=... forge test --match-contract V2ForkTest
contract V2ForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    bytes32 constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bool live;
    ZeroLuxFactoryV2 factory;
    ZeroLuxTreasury treasury;
    AgentWalletV2 wallet;
    uint256 identityId;
    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    uint256 ownerKey = 0xA11CE;
    address owner;
    uint256 customerKey = 0xC0FFEE;
    address customer;

    function setUp() public {
        string memory url = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        vm.setEvmVersion("cancun");
        live = true;
        owner = vm.addr(ownerKey);
        customer = vm.addr(customerKey);
        treasury = new ZeroLuxTreasury(admin);
        factory = new ZeroLuxFactoryV2(USDG, admin, operator, address(treasury), 2_000, REGISTRY);
        (uint256 id, address w) =
            factory.createAgent(owner, 1e6, 5e6, keccak256("spec"), "https://zerolux.fun/card/x.json", address(treasury), 2_000);
        wallet = AgentWalletV2(w);
        identityId = factory.agent(id).identityId;
        deal(USDG, customer, 10e6);
    }

    function _auth(uint256 value, bytes32 nonce) internal view returns (uint8 v, bytes32 r, bytes32 s, uint256 deadline) {
        deadline = block.timestamp + 600;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IUSDGv2(USDG).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(TRANSFER_TYPEHASH, customer, address(wallet), value, 0, deadline, nonce))
            )
        );
        (v, r, s) = vm.sign(customerKey, digest);
    }

    function test_fork_pay_takes_real_usdg_holds_the_run_and_bills_it() public {
        if (!live) return;
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _auth(1e6, "n1");
        vm.prank(operator);
        wallet.pay(customer, 1e6, 0, deadline, "n1", v, r, s, "run-1", 500_000);
        assertEq(IUSDGv2(USDG).balanceOf(address(wallet)), 1e6);
        assertEq(IUSDGv2(USDG).balanceOf(customer), 9e6);
        assertEq(wallet.heldTotal(), 600_000);

        // the same signed payment again: USDG accepts it and moves nothing, so the wallet refuses
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotPaid.selector);
        wallet.pay(customer, 1e6, 0, deadline, "n1", v, r, s, "run-2", 500_000);
        assertEq(IUSDGv2(USDG).balanceOf(customer), 9e6);

        // the owner cannot take what is set aside, even after pausing
        vm.startPrank(owner);
        wallet.setPaused(true);
        vm.expectRevert(AgentWalletV2.LienOwed.selector);
        wallet.withdraw(USDG, owner, 400_001);
        vm.stopPrank();

        vm.prank(operator);
        wallet.chargeAndSettle("run-1", 100_000, type(uint256).max);
        assertEq(IUSDGv2(USDG).balanceOf(address(treasury)), 120_000);
        assertEq(wallet.withdrawable(), 880_000);
    }

    function test_fork_bad_customer_signature_takes_nothing() public {
        if (!live) return;
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _auth(1e6, "n1");
        vm.prank(operator);
        vm.expectRevert(AgentWalletV2.NotPaid.selector);
        wallet.pay(customer, 2e6, 0, deadline, "n1", v, r, s, "run-1", 500_000); // signed for $1, presented as $2
        assertEq(IUSDGv2(USDG).balanceOf(customer), 10e6);
    }

    function test_fork_real_registry_accepts_the_wallet_as_the_agents_payment_wallet() public {
        if (!live) return;
        assertEq(IRegistryV2(REGISTRY).ownerOf(identityId), owner);
        assertEq(IRegistryV2(REGISTRY).getAgentWallet(identityId), address(0), "cleared when the identity was handed over");

        uint256 deadline = block.timestamp + 240;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                REGISTRY
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domain,
                keccak256(
                    abi.encode(
                        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                        identityId,
                        address(wallet),
                        owner,
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        bytes memory blob = abi.encode(identityId, deadline, abi.encodePacked(r, s, v));

        // a stranger cannot do it, even with the owner's signature in hand
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        IRegistryV2(REGISTRY).setAgentWallet(identityId, address(wallet), deadline, blob);

        vm.prank(owner);
        IRegistryV2(REGISTRY).setAgentWallet(identityId, address(wallet), deadline, blob);
        assertEq(IRegistryV2(REGISTRY).getAgentWallet(identityId), address(wallet));
    }
}
