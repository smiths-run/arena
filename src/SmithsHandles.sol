// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IIdentityOwner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title SmithsHandles — permanent human-readable handles for Smiths agents
/// @notice Maps a unique lowercase handle to an ERC-8004 agentId, once, forever.
///
///         The handle binds to the *identity*, never to a wallet: wallets can
///         rotate, identities are stable objects. Anything that needs the
///         current wallet resolves handle → agentId → IdentityRegistry, at
///         read time. There is deliberately no transfer, rename, release or
///         recycle path — a handle that changed hands would silently re-point
///         every recorded mention, mandate and copy-rule at a different actor.
///
///         Claiming requires being the identity's current owner, which in the
///         Smiths model is the agent's own wallet: the agent claims its name
///         the same way it does everything else — itself.
contract SmithsHandles {
    event HandleClaimed(
        bytes32 indexed handleHash, string handle, uint256 indexed agentId, address indexed claimant
    );

    IIdentityOwner public immutable identity;

    // agentId + 1, so an unclaimed handle (0) can never be confused with agentId 0.
    mapping(bytes32 => uint256) private _agentIdPlusOneByHandle;
    mapping(uint256 => string) private _handleByAgentId;
    mapping(uint256 => bool) private _agentHasHandle;
    mapping(bytes32 => bool) private _reserved;

    constructor(IIdentityOwner identity_, string[] memory reserved_) {
        identity = identity_;
        for (uint256 i = 0; i < reserved_.length; i++) {
            _reserved[keccak256(bytes(reserved_[i]))] = true;
        }
    }

    /// @notice Bind `handle` to `agentId`. Caller must own the ERC-8004 identity.
    function claim(string calldata handle, uint256 agentId) external {
        bytes memory b = bytes(handle);
        require(_isValidSyntax(b), "invalid handle");
        bytes32 h = keccak256(b);
        require(!_reserved[h], "reserved");
        require(_agentIdPlusOneByHandle[h] == 0, "taken");
        require(!_agentHasHandle[agentId], "agent already named");
        require(identity.ownerOf(agentId) == msg.sender, "not identity owner");

        _agentIdPlusOneByHandle[h] = agentId + 1;
        _handleByAgentId[agentId] = handle;
        _agentHasHandle[agentId] = true;
        emit HandleClaimed(h, handle, agentId, msg.sender);
    }

    function agentIdOf(string calldata handle) external view returns (uint256 agentId, bool exists) {
        uint256 v = _agentIdPlusOneByHandle[keccak256(bytes(handle))];
        if (v == 0) return (0, false);
        return (v - 1, true);
    }

    function handleOf(uint256 agentId) external view returns (string memory) {
        return _handleByAgentId[agentId];
    }

    function isAvailable(string calldata handle) external view returns (bool) {
        bytes memory b = bytes(handle);
        if (!_isValidSyntax(b)) return false;
        bytes32 h = keccak256(b);
        return !_reserved[h] && _agentIdPlusOneByHandle[h] == 0;
    }

    /// @dev ^[a-z][a-z0-9-]{2,15}$ — validated on bytes here, never trusted from a frontend.
    function _isValidSyntax(bytes memory b) private pure returns (bool) {
        if (b.length < 3 || b.length > 16) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool letter = c >= 0x61 && c <= 0x7A;
            bool digit = c >= 0x30 && c <= 0x39;
            bool dash = c == 0x2D;
            if (i == 0) {
                if (!letter) return false;
            } else if (!letter && !digit && !dash) {
                return false;
            }
        }
        return true;
    }
}
