// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/// @title Mozaic
/// @notice A shared 1000 x 1000 canvas on the ZVM. Anyone may paint any pixel
/// any 24-bit colour, for a fixed price per pixel, and a pixel painted later
/// covers one painted earlier. No ownership of pixels, no cooldown, no
/// allow-list. A bot is a first-class painter.
///
/// The owner can do three things and nothing else: withdraw what painting has
/// paid, clear the canvas back to white, and hand ownership on. The owner
/// cannot change the price or paint for free.
///
/// @dev The canvas is state, not only events, so a reader can load the whole
/// picture with a few `eth_call`s instead of replaying every paint since the
/// contract was deployed. Ten pixels share a storage slot (10 x 24 bits), so a
/// stroke across a row touches a tenth of the slots it would one per slot.
///
/// Clearing is an epoch, not a wipe. Zeroing 100,000 slots would cost about
/// 500M gas, thirty times the transaction cap, so each epoch has a canvas of
/// its own and `clear()` moves to the next, empty one: one cheap transaction,
/// and the whole board is white at once.
///
/// Colours are stored XOR 0xFFFFFF. Unwritten storage is zero, so an untouched
/// canvas reads as white, and painting a pixel white stores zero again.
///
/// Wire format, the one thing a bot needs to know: `paint(bytes)` takes six
/// bytes per pixel, `index (3 bytes) || rgb (3 bytes)`, big-endian, where
/// `index = y * 1000 + x`. It must be paid exactly `count * price` wei.
contract Mozaic {
    uint256 public constant WIDTH = 1000;
    uint256 public constant HEIGHT = 1000;
    uint256 public constant PIXELS_PER_SLOT = 10;
    uint256 public constant SLOTS = (WIDTH * HEIGHT) / PIXELS_PER_SLOT;

    /// @notice Wei per pixel. Fixed at deployment, so a bot that read it once
    /// never pays a price it did not see.
    uint256 public immutable price;

    /// @notice Who may withdraw, clear, and hand ownership on.
    address public owner;

    /// @notice Pixels painted since deployment, repaints included, across clears.
    uint256 public painted;

    /// @notice Which canvas is current. Starts at 0; each `clear()` adds one.
    uint256 public epoch;

    mapping(uint256 => uint256[SLOTS]) private canvases;

    event Painted(address indexed painter, uint256 count, bytes pixels);
    event Cleared(uint256 indexed epoch);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Mozaic: not the owner");
        _;
    }

    constructor(uint256 price_, address owner_) {
        require(owner_ != address(0), "Mozaic: no owner");
        price = price_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Paints `pixels.length / 6` pixels, in order, so a later entry
    /// for the same index wins. An index off the canvas reverts the whole call.
    function paint(bytes calldata pixels) external payable {
        uint256 n = pixels.length / 6;
        require(n > 0 && pixels.length == n * 6, "Mozaic: 6 bytes per pixel");
        require(msg.value == n * price, "Mozaic: pay price per pixel");
        uint256[SLOTS] storage canvas = canvases[epoch];
        uint256 base;
        assembly {
            base := pixels.offset
        }
        // The slot being edited is held in memory until a pixel lands in a
        // different one, so a row sent in index order reads and writes each
        // slot once rather than once per pixel.
        uint256 open = type(uint256).max;
        uint256 value;
        for (uint256 i = 0; i < n; ) {
            uint256 word;
            assembly {
                // The top 48 bits of the 32 bytes at this pixel. Reading past
                // the end of calldata yields zeros, which the shift discards.
                word := shr(208, calldataload(add(base, mul(i, 6))))
            }
            uint256 index = word >> 24;
            require(index < WIDTH * HEIGHT, "Mozaic: off the canvas");
            uint256 slot = index / PIXELS_PER_SLOT;
            if (slot != open) {
                if (open != type(uint256).max) canvas[open] = value;
                open = slot;
                value = canvas[slot];
            }
            uint256 shift = (index % PIXELS_PER_SLOT) * 24;
            value = (value & ~(uint256(0xFFFFFF) << shift)) | (((word & 0xFFFFFF) ^ 0xFFFFFF) << shift);
            unchecked {
                ++i;
            }
        }
        canvas[open] = value;
        unchecked {
            painted += n;
        }
        emit Painted(msg.sender, n, pixels);
    }

    /// @notice One pixel's colour as 0xRRGGBB.
    function pixel(uint256 x, uint256 y) external view returns (uint256) {
        require(x < WIDTH && y < HEIGHT, "Mozaic: off the canvas");
        uint256 index = y * WIDTH + x;
        return ((canvases[epoch][index / PIXELS_PER_SLOT] >> ((index % PIXELS_PER_SLOT) * 24)) & 0xFFFFFF) ^ 0xFFFFFF;
    }

    /// @notice A raw slot of the current canvas: pixel `slot * 10 + k` is bits
    /// `24k .. 24k + 23`, XOR 0xFFFFFF.
    function slotAt(uint256 slot) external view returns (uint256) {
        return canvases[epoch][slot];
    }

    /// @notice The written slots among `count` from `start`, for loading the
    /// canvas: 36 bytes each, `slot (uint32) || value (uint256)`. Unwritten
    /// slots (ten white pixels) are left out, so a mostly empty canvas costs
    /// little to read, and a full one about an eighth more than raw.
    function chunk(uint256 start, uint256 count) external view returns (bytes memory out) {
        uint256 end = start + count;
        if (end > SLOTS) end = SLOTS;
        if (start >= end) return out;
        uint256[SLOTS] storage canvas = canvases[epoch];
        out = new bytes((end - start) * 36);
        uint256 p;
        assembly {
            p := add(out, 32)
        }
        for (uint256 s = start; s < end; ) {
            uint256 v = canvas[s];
            if (v != 0) {
                assembly {
                    mstore(p, shl(224, s))
                    mstore(add(p, 4), v)
                    p := add(p, 36)
                }
            }
            unchecked {
                ++s;
            }
        }
        assembly {
            mstore(out, sub(p, add(out, 32)))
        }
    }

    /// @notice Clears the whole canvas to white, at once: the next epoch's
    /// canvas is empty. What painting has paid is untouched.
    function clear() external onlyOwner {
        unchecked {
            ++epoch;
        }
        emit Cleared(epoch);
    }

    /// @notice Sends everything painting has paid to `to`.
    function withdraw(address payable to) external onlyOwner {
        require(to != address(0), "Mozaic: no recipient");
        uint256 amount = address(this).balance;
        emit Withdrawn(to, amount);
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Mozaic: transfer failed");
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Mozaic: no owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
