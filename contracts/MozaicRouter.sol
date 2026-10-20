// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IMozaic {
    function price() external view returns (uint256);
    function paint(bytes calldata pixels) external payable;
}

/// @title MozaicRouter
/// @notice A front door to a Mozaic canvas that does two things the canvas
/// cannot: it takes paint in a compact form, and it knows who is painting when
/// a paint session signs for them.
///
/// @dev Why compact. On zvm69 the relayer can afford about three full NoM
/// blocks of data a momentum, so the chain's paint throughput is bytes, not
/// gas: at six bytes a pixel a session got about two 4,000-pixel paints into a
/// momentum. Here a run of one colour is 8 bytes however long, and a span of
/// neighbouring pixels is 3 bytes each. The router expands them to the
/// canvas's format in memory, which costs gas, not NoM bytes.
///
/// Why sessions. A page that paints a big draft signs its batches with a key
/// of its own (one wallet prompt, not 250), and the canvas would credit that
/// key. The wallet funds the key through `open`, which records who funded it,
/// and every paint through here names that wallet in `PaintedBy`, just before
/// the canvas's own `Painted` in the same transaction.
///
/// Ops, concatenated, big-endian:
///   0x01 index(3) count(2) rgb(3)            count pixels from index, one colour
///   0x02 index(3) count(2) rgb(3) * count    count pixels from index, a colour each
/// Payment is exactly price() times the pixels the ops expand to.
contract MozaicRouter {
    IMozaic public immutable canvas;
    uint256 public immutable price;

    /// @notice A session key and the wallet that funded it.
    mapping(address => address) public ownerOf;

    event Session(address indexed owner, address indexed session, uint256 value);
    event PaintedBy(address indexed artist, address indexed sender, uint256 count);

    constructor(IMozaic canvas_) {
        canvas = canvas_;
        price = canvas_.price();
    }

    /// @notice Funds a session key and records the caller as its owner. The
    /// first funder of a key owns it; nobody else can fund it after.
    function open(address payable session) external payable {
        address owner = ownerOf[session];
        if (owner == address(0)) ownerOf[session] = msg.sender;
        else require(owner == msg.sender, "MozaicRouter: someone else's session");
        emit Session(msg.sender, session, msg.value);
        (bool ok, ) = session.call{value: msg.value}("");
        require(ok, "MozaicRouter: transfer failed");
    }

    /// @notice Who a paint by `sender` is credited to.
    function artistOf(address sender) public view returns (address) {
        address owner = ownerOf[sender];
        return owner == address(0) ? sender : owner;
    }

    function paint(bytes calldata ops) external payable {
        bytes memory px = expand(ops);
        uint256 n = px.length / 6;
        require(n > 0, "MozaicRouter: nothing to paint");
        require(msg.value == n * price, "MozaicRouter: pay price per pixel");
        emit PaintedBy(artistOf(msg.sender), msg.sender, n);
        canvas.paint{value: msg.value}(px);
    }

    /// @notice The canvas's six-bytes-a-pixel form of `ops`.
    function expand(bytes calldata ops) public pure returns (bytes memory px) {
        uint256 end = ops.length;
        uint256 base;
        assembly {
            base := ops.offset
        }
        // First pass: how many pixels, and that every op is whole.
        uint256 n;
        for (uint256 o = 0; o < end; ) {
            require(o + 9 <= end, "MozaicRouter: truncated op");
            uint256 head;
            assembly {
                head := shr(184, calldataload(add(base, o)))
            }
            // head: op(1) index(3) count(2) rgb(3), 9 bytes
            uint256 op = head >> 64;
            uint256 count = (head >> 24) & 0xFFFF;
            require(count > 0, "MozaicRouter: empty op");
            if (op == 1) o += 9;
            else if (op == 2) {
                // The first colour is in the header; the other count - 1 follow it.
                o += 9 + (count - 1) * 3;
                require(o <= end, "MozaicRouter: truncated span");
            } else revert("MozaicRouter: unknown op");
            n += count;
        }
        px = new bytes(n * 6);
        uint256 p;
        assembly {
            p := add(px, 32)
        }
        for (uint256 o = 0; o < end; ) {
            uint256 head;
            assembly {
                head := shr(184, calldataload(add(base, o)))
            }
            uint256 op = head >> 64;
            uint256 index = (head >> 40) & 0xFFFFFF;
            uint256 count = (head >> 24) & 0xFFFF;
            uint256 rgb = head & 0xFFFFFF;
            for (uint256 k = 0; k < count; ) {
                if (op == 2 && k > 0) {
                    assembly {
                        rgb := shr(232, calldataload(add(base, add(add(o, 9), mul(sub(k, 1), 3)))))
                    }
                }
                // index(3) || rgb(3), written as the top six bytes of a word.
                assembly {
                    mstore(p, shl(208, or(shl(24, add(index, k)), rgb)))
                    p := add(p, 6)
                }
                unchecked {
                    ++k;
                }
            }
            o += op == 1 ? 9 : 9 + (count - 1) * 3;
        }
    }
}
