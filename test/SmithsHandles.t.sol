// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SmithsHandles, IIdentityOwner} from "../src/SmithsHandles.sol";

contract MockIdentity is IIdentityOwner {
    mapping(uint256 => address) public owners;

    function set(uint256 id, address owner) external {
        owners[id] = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = owners[tokenId];
        require(o != address(0), "nonexistent");
        return o;
    }
}

contract SmithsHandlesTest is Test {
    MockIdentity internal identity;
    SmithsHandles internal handles;

    address internal agentWallet = makeAddr("agentWallet");
    address internal stranger = makeAddr("stranger");
    uint256 internal constant AGENT_ID = 859_270;

    function setUp() public {
        identity = new MockIdentity();
        identity.set(AGENT_ID, agentWallet);
        identity.set(0, agentWallet); // agentId zero must work too

        string[] memory reserved = new string[](2);
        reserved[0] = "smiths";
        reserved[1] = "treasury";
        handles = new SmithsHandles(identity, reserved);
    }

    function test_IdentityOwnerClaimsAndResolves() public {
        vm.prank(agentWallet);
        handles.claim("test1", AGENT_ID);

        (uint256 id, bool exists) = handles.agentIdOf("test1");
        assertTrue(exists);
        assertEq(id, AGENT_ID);
        assertEq(handles.handleOf(AGENT_ID), "test1");
        assertFalse(handles.isAvailable("test1"));
    }

    function test_AgentIdZeroIsNotConfusedWithUnclaimed() public {
        vm.prank(agentWallet);
        handles.claim("zeroed", 0);

        (uint256 id, bool exists) = handles.agentIdOf("zeroed");
        assertTrue(exists);
        assertEq(id, 0);

        (, bool ghost) = handles.agentIdOf("unclaimed");
        assertFalse(ghost);
    }

    function test_OnlyIdentityOwnerMayClaim() public {
        vm.prank(stranger);
        vm.expectRevert("not identity owner");
        handles.claim("test1", AGENT_ID);
    }

    function test_HandleIsPermanentlyUnique() public {
        vm.prank(agentWallet);
        handles.claim("test1", AGENT_ID);

        identity.set(7, stranger);
        vm.prank(stranger);
        vm.expectRevert("taken");
        handles.claim("test1", 7);
    }

    function test_OneHandlePerAgent() public {
        vm.prank(agentWallet);
        handles.claim("test1", AGENT_ID);

        vm.prank(agentWallet);
        vm.expectRevert("agent already named");
        handles.claim("second", AGENT_ID);
    }

    function test_ReservedHandlesCannotBeClaimed() public {
        vm.prank(agentWallet);
        vm.expectRevert("reserved");
        handles.claim("smiths", AGENT_ID);
        assertFalse(handles.isAvailable("treasury"));
    }

    function test_SyntaxIsEnforcedOnBytes() public {
        string[8] memory bad = [
            "ab",
            "Test1",
            "1agent",
            "-lead",
            "has_underscore",
            "has space",
            "waaaaaaaaaaaytoolong",
            unicode"tükçe"
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            assertFalse(handles.isAvailable(bad[i]), bad[i]);
            vm.prank(agentWallet);
            vm.expectRevert("invalid handle");
            handles.claim(bad[i], AGENT_ID);
        }

        assertTrue(handles.isAvailable("test1"));
        assertTrue(handles.isAvailable("market-rat"));
        assertTrue(handles.isAvailable("arc7"));
    }

    function test_HandleFollowsIdentityNotWallet() public {
        vm.prank(agentWallet);
        handles.claim("test1", AGENT_ID);

        // The identity changes owner; the handle still resolves to the same agentId.
        identity.set(AGENT_ID, stranger);
        (uint256 id, bool exists) = handles.agentIdOf("test1");
        assertTrue(exists);
        assertEq(id, AGENT_ID);
        // Current wallet is resolved through the registry at read time.
        assertEq(identity.ownerOf(id), stranger);
    }
}
