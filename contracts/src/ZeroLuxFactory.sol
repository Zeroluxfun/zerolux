// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {AgentWallet} from "./AgentWallet.sol";

/// @dev The ERC-8004 identity registry: one token per agent, pointing at its card.
interface IIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title ZeroLuxFactory
/// @notice Registers agents and deploys one wallet per agent. Holds the three
///         settings every wallet reads: who may meter runs (operator), where
///         run charges go (treasury) and the markup on a run's model cost.
/// @dev    This contract never holds money. Each wallet copies the treasury
///         and markup when it is made and keeps them until its own owner
///         adopts new ones, so a stolen owner key here cannot redirect or
///         reprice an existing wallet. The operator can be replaced at once,
///         because that is the key most likely to leak.
contract ZeroLuxFactory {
    uint16 public constant MAX_MARKUP_BPS = 5_000; // 50%
    uint256 public constant TREASURY_DELAY = 2 days;

    address public immutable usdg;
    address public immutable walletImplementation;
    address public immutable identityRegistry; // ERC-8004; zero if this chain has none

    address public owner;
    address public pendingOwner;
    address public operator;
    address public treasury;
    address public pendingTreasury;
    uint256 public pendingTreasuryAt;
    uint16 public markupBps;

    struct Agent {
        address wallet;
        address creator;
        bytes32 specHash; // hash of the agent's published spec
        uint64 createdAt;
        bool hasIdentity;
        uint256 identityId; // its ERC-8004 id, when hasIdentity
    }

    bool private _registering;

    Agent[] private _agents;
    mapping(address wallet => uint256 idPlusOne) public agentIdOf;
    mapping(address creator => uint256 count) public createdBy;

    event AgentCreated(uint256 indexed id, address indexed wallet, address indexed creator, bytes32 specHash);
    event IdentityRegistered(uint256 indexed id, uint256 indexed identityId);
    event OperatorSet(address indexed operator);
    event MarkupSet(uint16 markupBps);
    event TreasuryProposed(address indexed treasury, uint256 effectiveAt);
    event TreasurySet(address indexed treasury);
    event OwnershipOffered(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error ZeroAddress();
    error MarkupTooHigh();
    error TooEarly();
    error NothingPending();
    error TermsChanged();
    error BadIdentity();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address usdg_,
        address owner_,
        address operator_,
        address treasury_,
        uint16 markupBps_,
        address identityRegistry_
    ) {
        if (usdg_ == address(0) || owner_ == address(0) || operator_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (markupBps_ > MAX_MARKUP_BPS) revert MarkupTooHigh();
        usdg = usdg_;
        identityRegistry = identityRegistry_;
        owner = owner_;
        operator = operator_;
        treasury = treasury_;
        markupBps = markupBps_;
        walletImplementation = address(new AgentWallet());
        emit OwnershipTransferred(address(0), owner_);
        emit OperatorSet(operator_);
        emit TreasurySet(treasury_);
        emit MarkupSet(markupBps_);
    }

    /// @notice Anyone may put an agent on the line. `agentOwner` owns its wallet.
    ///         The wallet takes the factory's treasury and markup as they stand;
    ///         the call fails if they are not what the caller expects.
    ///         Pass an `agentURI` to also give it an ERC-8004 identity, owned by
    ///         `agentOwner`; pass an empty string to skip that.
    function createAgent(
        address agentOwner,
        uint128 perRunCap,
        uint128 perDayCap,
        bytes32 specHash,
        string calldata agentURI,
        address expectedTreasury,
        uint16 expectedMarkupBps
    ) external returns (uint256 id, address wallet) {
        // The wallet keeps these for life, so the caller names what they expect.
        if (treasury != expectedTreasury || markupBps != expectedMarkupBps) revert TermsChanged();
        id = _agents.length;
        wallet = _clone(walletImplementation, keccak256(abi.encode(msg.sender, createdBy[msg.sender]++)));
        AgentWallet(wallet).init(agentOwner, perRunCap, perDayCap);
        _agents.push(Agent(wallet, msg.sender, specHash, uint64(block.timestamp), false, 0));
        agentIdOf[wallet] = id + 1;
        emit AgentCreated(id, wallet, msg.sender, specHash);

        if (bytes(agentURI).length != 0 && identityRegistry != address(0)) {
            _registering = true;
            uint256 identityId = IIdentityRegistry(identityRegistry).register(agentURI);
            _registering = false;
            if (IIdentityRegistry(identityRegistry).ownerOf(identityId) != address(this)) revert BadIdentity();
            IIdentityRegistry(identityRegistry).transferFrom(address(this), agentOwner, identityId);
            _agents[id].hasIdentity = true;
            _agents[id].identityId = identityId;
            emit IdentityRegistered(id, identityId);
        }
    }

    /// @dev The registry mints the identity here before it is passed to the
    ///      agent's owner. Safe transfers are refused at any other time. A token
    ///      pushed here with a plain transfer cannot be recovered.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (!_registering || msg.sender != identityRegistry) revert NotOwner();
        return 0x150b7a02;
    }

    function agentCount() external view returns (uint256) {
        return _agents.length;
    }

    function agent(uint256 id) external view returns (Agent memory) {
        return _agents[id];
    }

    function isAgentWallet(address wallet) external view returns (bool) {
        return agentIdOf[wallet] != 0;
    }

    // ---- owner ----

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setMarkup(uint16 markupBps_) external onlyOwner {
        if (markupBps_ > MAX_MARKUP_BPS) revert MarkupTooHigh();
        markupBps = markupBps_;
        emit MarkupSet(markupBps_);
    }

    function proposeTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        pendingTreasury = treasury_;
        pendingTreasuryAt = block.timestamp + TREASURY_DELAY;
        emit TreasuryProposed(treasury_, pendingTreasuryAt);
    }

    function acceptTreasury() external onlyOwner {
        if (pendingTreasury == address(0)) revert NothingPending();
        if (block.timestamp < pendingTreasuryAt) revert TooEarly();
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        pendingTreasuryAt = 0;
        emit TreasurySet(treasury);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipOffered(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @dev EIP-1167 minimal proxy, created with CREATE2.
    function _clone(address implementation, bytes32 salt) private returns (address instance) {
        assembly ("memory-safe") {
            mstore(0x00, or(shr(0xe8, shl(0x60, implementation)), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000))
            mstore(0x20, or(shl(0x78, implementation), 0x5af43d82803e903d91602b57fd5bf3))
            instance := create2(0, 0x09, 0x37, salt)
        }
        if (instance == address(0)) revert ZeroAddress();
    }
}
