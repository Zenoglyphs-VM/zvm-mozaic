// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/// @dev A controlled recipient for testing failed transfers and later recovery.
contract NativeReceiver {
    bool public reject = true;

    function setReject(bool value) external {
        reject = value;
    }

    receive() external payable {
        require(!reject, "Fixture: payment rejected");
    }
}
