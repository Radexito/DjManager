# Firmware analysis scripts

These are the tools behind `../FIRMWARE_2K.md`. They are evidence of method, not a
product: each one takes a byte image and reports what it finds. Nothing here
requires a particular machine, and **no firmware is redistributed** in this
repository.

## Firmware

Download the `.UPD` files yourself from the vendor's firmware downloads for your
model, then make them available to the scripts in one of two ways:

```sh
export CDJ_FW_DIR=/path/to/your/firmware     # preferred
mkdir -p ../firmware                         # or drop them next to this directory
```

Putting them in `reverse-engineering/firmware/` is the zero-configuration option;
that path is gitignored so firmware cannot be committed by accident.

## Tools

The scripts call `bfin-elf-objdump` (Blackfin, for the GUI board) and
`sh4-linux-gnu-objdump` (SH-4, for the MAIN board). Build binutils for the targets
you need, for example:

```sh
./configure --target=bfin-elf --enable-targets=bfin-elf,arm-linux-gnueabi,aarch64-linux-gnu \
  --disable-nls --disable-werror --prefix="$HOME/binutils-cdj"
make -j"$(nproc)" && make install

./configure --target=sh4-linux-gnu --enable-targets=sh4-linux-gnu,sh-elf \
  --disable-nls --disable-werror --prefix="$HOME/binutils-cdj-sh4"
make -j"$(nproc)" && make install
```

Then either put both `bin` directories on `PATH` or point at them explicitly:

```sh
export CDJ_OBJDUMP="$HOME/binutils-cdj/bin"
```

Note that a full `--enable-targets=all` build fails on binutils 2.39 with a modern
GCC (a `static_assert` without `assert.h` in the MIPS sources), so list the targets
you want instead of asking for all of them.

## Scripts

| script                          | what it does                                                |
| ------------------------------- | ----------------------------------------------------------- |
| `split_components.py`           | splits a `.UPD` container and decodes its S-record payloads |
| `srec_decode2.py`               | address-correct S-record decode, counting overlaps          |
| `census.py`                     | container census: sizes, entropy, magic bytes, codec probes |
| `code_map.py`                   | illegal-opcode rate per sampled window, best of 4 phases    |
| `component_codescan.py`         | the same over decoded component images                      |
| `arm_fingerprint.py`            | ARM/Thumb prologue and branch-target fingerprint            |
| `ascii_control.py`              | control: does ASCII text fake a low illegal-opcode rate?    |
| `lz_trials.py`, `raw_trials.py` | codec trials (LZ4, Snappy, LZF, deflate, LZMA, LZSS)        |
| `paths.py`                      | shared input and tool resolution (see above)                |

## Publishing rule

Keep machine-specific paths out of anything committed here. Scripts resolve inputs
through `paths.py`, so use `CDJ_FW_DIR`, `CDJ_OBJDUMP` or command-line arguments
rather than absolute paths, and never commit a path that identifies a particular
machine or person.
