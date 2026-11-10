"""Check 16 KB PT_LOAD alignment in the APK's 64-bit native libraries."""

import pathlib
import subprocess
import sys
import tempfile
import zipfile


def main() -> None:
    apk = pathlib.Path(sys.argv[1])
    with zipfile.ZipFile(apk) as archive, tempfile.TemporaryDirectory() as temporary:
        libraries = [
            name for name in archive.namelist()
            if name.startswith(("lib/arm64-v8a/", "lib/x86_64/")) and name.endswith(".so")
        ]
        if not libraries:
            raise SystemExit("No 64-bit native libraries found")

        for index, name in enumerate(libraries):
            library = pathlib.Path(temporary) / f"library-{index}.so"
            library.write_bytes(archive.read(name))
            output = subprocess.check_output(
                ["readelf", "--program-headers", "--wide", str(library)],
                text=True, encoding="utf-8",
            )
            segments = [line.split() for line in output.splitlines() if line.strip().startswith("LOAD ")]
            if not segments:
                raise SystemExit(f"No PT_LOAD segments in {name}")
            for segment in segments:
                offset, address, alignment = int(segment[1], 16), int(segment[2], 16), int(segment[-1], 16)
                if alignment < 16384 or (address - offset) % 16384:
                    raise SystemExit(f"16 KB alignment failed for {name}")
            print(f"PASS {name}: {len(segments)} PT_LOAD segments aligned to 16 KB")


if __name__ == "__main__":
    main()
