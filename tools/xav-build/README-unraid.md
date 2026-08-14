# xav CUDA build + TQ benchmark — run these on the Unraid host

No GPU passthrough. Everything happens in containers, which is the path that
already works on this host.

Files here:

- `Dockerfile.xav-build` — CUDA build environment (Ubuntu 24.04 + nvcc + toolchain)
- `fix-dav1d-multiarch.sh` — entrypoint; applies the one patch xav needs on Ubuntu
- `run-tq-bench.sh` — runs the TQ benchmark with the CUDA binary

## Why the build must happen on the host

`vship.mk` builds the CUDA backend with:

```make
nvcc -x cu src/VshipLib.cpp ... -arch=native ...
```

`-arch=native` asks an installed GPU for its compute capability, so the GPU must be
visible **during the build**. That is why this is a build container on the host and not
something we can do on the GPU-less VM.

`-march=native` (C/C++ and RUSTFLAGS) also targets the build machine's CPU — which is
correct here, since the host is the machine that will run the encodes.

## 1. Build

```bash
cd /path/to/this/dir
docker build -f Dockerfile.xav-build -t xav-build .

git clone https://github.com/emrakyz/xav /mnt/user/appdata/xav
cd /mnt/user/appdata/xav

docker run --rm --gpus all \
  -e NVIDIA_DRIVER_CAPABILITIES=all \
  -v "$PWD:/xav" -w /xav \
  xav-build ./build.sh static_tq hdr
```

`static_tq` = mode 1 (builds Vship). With the GPU visible, `has_nvidia()` flips the
backend to **cuda** automatically — you should see `Hardware backend: cuda` in the log,
and Vship will build via `nvcc` rather than clang++/SPIR-V.

Result: `/mnt/user/appdata/xav/target/release/xav`

Expect ~6-10 minutes: it builds opus, dav1d, FFmpeg and SVT-AV1 (including a PGO pass
that downloads a 4K training clip), then fat-LTO links the Rust binary.

### If the build fails or is interrupted

- **Interrupted mid-PGO** leaves an *instrumented* `libSvtAv1Enc.a` that xav's
  `cleanup_existing()` mistakes for a finished build. Every later run then links it and
  dies with `undefined symbol: __llvm_profile_instrument_target`.
  Fix: `rm -rf ~/.local/src/SVT-AV1` (inside the container's HOME, or wherever
  `BUILD_DIR` landed) and rebuild.
- **After changing any dependency**, run `cargo clean` first. `build.sh` only does that
  on its interactive path, and cargo does not track `libSvtAv1Enc.a`, so a rebuild can
  report "Build complete" in zero seconds while silently keeping the old binary.

## 2. Verify CUDA actually got built in

**The `ldd | grep -i cuda` check does not work — it is a false negative.**
xav does not link `libcuda.so.1`; it `dlopen`s it at runtime. On a confirmed-CUDA
build `ldd` shows only libm/libgcc_s/libc, and `libcuda.so.1` appears merely as an
embedded *string*. Judging the build by `ldd` will make you reject a good binary.

Use the fatbin's target architecture instead — this is positive proof that
`nvcc -arch=native` saw a real GPU at build time:

```bash
docker run --rm -v /mnt/user/appdata/xav/target/release/xav:/x:ro \
  --entrypoint bash xav-build -c 'cuobjdump /x | grep -i arch'
# arch = sm_86      <- RTX 3060 (compute capability 8.6). Confirmed CUDA build.
```

Corroborating evidence in the same binary:

```bash
strings -a /x | grep -iE 'libcuda|libnvrtc'      # -> libcuda.so.1  (dlopen target)
strings -a /x | grep -oE 'cu(Init|LaunchKernel|MemAllocAsync)'   # driver API symbols
strings -a /x | grep -oiE 'cvvdp'                # CVVDP is CUDA-only
```

And the build log line `Hardware backend: cuda`. Note that `has_nvidia()` decides this
by grepping `/sys/bus/pci/devices/*/vendor` for `0x10de` — sysfs exposes the host's PCI
devices inside a container, so this works without passthrough.

## 3. Benchmark

**Do not use `run-tq-bench.sh`'s default `-t 10.0-10.2`.** That range is the TARGET
SCORE; its magnitude only incidentally selects the metric. SSIMULACRA2 10 is atrocious
quality (90+ = visually lossless, 70-90 = high, 50-70 = medium), so TQ raises CRF as far
as it is allowed trying to get *down* to 10, and stops at the ceiling. Measured here: all
20 chunks pinned at `crf=40.00`, the top of `-f 20-40`, achieving 48.8-81.1. That is not
target-quality mode — it is a fixed CRF-40 encode that also paid for 3 probe encodes per
chunk, and its output is not comparable to av1an targeting VMAF 95.

Use `run-tq-sweep.sh`, which sweeps real targets and reports achieved mean/min score,
mean CRF, and how many chunks saturated a CRF bound:

```bash
bash run-tq-sweep.sh <xav-binary> <source.mkv> <preset> <crf-range> <target...>
bash run-tq-sweep.sh .../xav bench_src.mkv 4 10-40 84.8-85.2
bash run-tq-sweep.sh .../xav bench_src.mkv 4 1-40  89.8-90.2   # 90 needs floor < 10
```

**Always check the CRF range did not bind.** A run where most chunks sit at the floor or
the ceiling is a fixed-CRF encode wearing a target-quality costume. Targeting 90 with
`-f 10-40` pinned 17/20 chunks at the floor and reached only 86-89; dropping the floor to
1 converged all 20 in-band at mean CRF 8.03.

## Two constraints that are not optional

- **`--security-opt seccomp=unconfined`** — xav uses `io_uring`, which Docker's default
  seccomp profile blocks. Without it the encode succeeds and then the **mux** fails with
  `io_uring_setup failed (errno 1)`.
- **A PTY** — `src/y4m.rs` decides pipe-input mode with `is_pipe() == !isatty(0)`, with no
  flag or env override. Without a TTY, xav waits for Y4M frames on stdin, gets none, and
  writes an ~870-byte file while printing `DONE 100.00%` and exiting 0. `/dev/null` and a
  closed stdin fail the same way. Hence `script -qec ... /dev/null` in the run script.
  **Any future Tdarr plugin must allocate a PTY for the same reason.**
