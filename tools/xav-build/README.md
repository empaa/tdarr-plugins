# Building xav

The xav plugins need a `xav` binary that this repo does not ship. This directory holds the
toolchain that produces one, kept here because it is tangled with this project specifically
and will be needed again whenever xav is upgraded.

It was previously host-only, under `/mnt/cache_nvme_two/vm_data/xav-work/host/` on the Unraid
box. That is a working directory, not a home — it is one `rm -rf` away from being lost, and
the knowledge encoded in these comments took real time to recover.

| file | what |
|---|---|
| `Dockerfile.xav-build` | CUDA build container, **must run on a host with the GPU visible** |
| `fix-dav1d-multiarch.sh` | entrypoint patch, `COPY`d in by the Dockerfile — not optional |
| `build-ffvship.sh` | builds the self-contained FFVship bundle (SSIMULACRA2 scoring) |
| `README-unraid.md` | the original host-side notes |

## Why it must build on the host, not the VM

`vship.mk` compiles with `nvcc -arch=native`, which queries an **installed GPU** for its
compute capability. The VM has no GPU, so the build must run where the card is. That is the
entire reason a host build container exists rather than building alongside this repo.

    docker build -f Dockerfile.xav-build -t xav-build .

    docker run --rm --gpus all \
      -e NVIDIA_DRIVER_CAPABILITIES=all \
      -v /path/to/xav-source:/xav -w /xav \
      xav-build ./build.sh static_tq hdr     # or: static_tq mainline

Result: `/xav/target/release/xav`. Base is Ubuntu 24.04 (glibc 2.39) to match the official
Tdarr image, so the binary satisfies its GLIBC_2.38 floor.

## Three traps the Dockerfile already guards

Each of these produced a confusing failure a long way from its cause:

1. **`libclang-rt-18-dev` is required and is not pulled in by clang/llvm on Ubuntu.** Without
   it xav's `detect_deps()` sets `HAS_HARD_REQS=false`, which the preset path never consults —
   so `./build.sh static_tq hdr` sails past and dies much later with an unrelated-looking link
   error. The Dockerfile gates on the archive existing.
2. **Rust nightly is mandatory, and `curl … | sh` can install nothing while reporting success.**
   Docker `RUN` is `/bin/sh -c` with no `pipefail`, so a failed download feeds `sh` an empty
   script and the step exits 0. It happened once on a transient CloudFront failure. Download
   and execute are separate, individually checked steps.
3. **dav1d's pkg-config libdir.** Upstream's sed only strips a bare `lib`/`lib64`, but
   Debian/Ubuntu meson emits `libdir=${prefix}/lib/x86_64-linux-gnu`, so the multiarch suffix
   survives and points nowhere. FFmpeg's configure then reports the misleading
   "dav1d >= 1.0.0 not found using pkg-config". `fix-dav1d-multiarch.sh` patches it at build
   time so we do not have to fork `build.sh`.

## Verifying the result

`ldd | grep cuda` shows **nothing** on a correct binary — xav `dlopen`s libcuda rather than
linking it, so ldd cannot tell you whether the CUDA backend is present. Use:

    cuobjdump <binary> | grep arch

`arch = sm_86` is an RTX 3060, i.e. `-arch=native` saw the real GPU at build time.

## Deploying a build

The binary is self-contained; mount it into any Tdarr node image. See
[Providing the xav binary](../../README.md#providing-the-xav-binary).
