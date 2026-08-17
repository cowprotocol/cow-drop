// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";

/// @dev Records who called it, so tests can prove a call ran *as the shed*.
contract Recorder {
    address public lastCaller;
    uint256 public pings;
    uint256 public lastValue;

    function ping() external payable {
        lastCaller = msg.sender;
        pings++;
        lastValue = msg.value;
    }
}

contract MockERC20 {
    string public name = "Mock";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Just enough GPv2Settlement to observe pre-signatures.
contract MockSettlement {
    bytes32 public immutable domainSeparator;

    mapping(bytes32 => bool) internal signed;
    mapping(bytes32 => address) public signerOf;

    constructor(bytes32 domainSeparator_) {
        domainSeparator = domainSeparator_;
    }

    function setPreSignature(bytes calldata orderUid, bool signed_) external {
        signed[keccak256(orderUid)] = signed_;
        signerOf[keccak256(orderUid)] = msg.sender;
    }

    function preSignature(bytes calldata orderUid) external view returns (uint256) {
        return signed[keccak256(orderUid)] ? type(uint256).max : 0;
    }
}

/// @dev Just enough ComposableCoW to observe conditional-order registration.
contract MockComposableCow {
    bytes32 public immutable domainSeparator;

    mapping(address => mapping(bytes32 => bool)) public singleOrders;
    mapping(address => mapping(bytes32 => bytes32)) public cabinet;

    address public lastValueFactory;
    bool public lastDispatch;
    uint256 public createCount;

    constructor(bytes32 domainSeparator_) {
        domainSeparator = domainSeparator_;
    }

    function create(IConditionalOrder.ConditionalOrderParams calldata params, bool dispatch) public {
        singleOrders[msg.sender][keccak256(abi.encode(params))] = true;
        lastDispatch = dispatch;
        createCount++;
    }

    function createWithContext(
        IConditionalOrder.ConditionalOrderParams calldata params,
        address valueFactory,
        bytes calldata,
        bool dispatch
    ) external {
        create(params, dispatch);
        lastValueFactory = valueFactory;
        // Mirrors the real contract seeding the cabinet from the value factory; the only factory
        // this project uses returns block.timestamp.
        cabinet[msg.sender][keccak256(abi.encode(params))] = bytes32(block.timestamp);
    }
}

contract MockWrappedNative {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }
}
