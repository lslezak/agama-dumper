#! /usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { program } from "commander";

// define command line arguments
program
  .description("Start an Agama instance in a VM")
  .requiredOption("-i, --iso <iso>", "ISO image to boot");

program.parse();
const options = program.opts();

// root password configured for the started Agama instance
// (base64url avoids "+", "/" and "=" which could be a problem on the kernel command line)
const password = crypto.randomBytes(8).toString("base64url").slice(0, 8);

let tmpdir;
try {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "agama-vm-"));

  // create 50GiB sparse file for the raw disk image
  const disk = path.join(tmpdir, "disk");
  fs.writeFileSync(disk, "");
  fs.truncateSync(disk, 50 * 1024 ** 3);

  const linux = path.join(tmpdir, "linux");
  const initrd = path.join(tmpdir, "initrd");

  // extract a file from the ISO image, use "isoinfo" if available, otherwise fall back to "xorriso"
  const extract = (source: string, target: string) => {
    const result = spawnSync("isoinfo", ["-R", "-i", options.iso, "-x", source, ">", target], {
      shell: true,
    });

    // exit code 127 = command not found in the shell
    if (result.status === 127) {
      spawnSync(
        "xorriso",
        ["-osirrox", "on", "-indev", options.iso, "-extract", source, target],
        { stdio: "inherit" },
      );
    }
  };

  extract("/boot/x86_64/loader/linux", linux);
  extract("/boot/x86_64/loader/initrd", initrd);

  console.log("Starting Agama VM...\n");
  console.log("Connect to https://localhost:4433");
  console.log('Or use "ssh root@localhost -p 2222"');
  console.log(`Root password: ${password}`);

  spawnSync("qemu-kvm", [
    "-cpu",
    "qemu64",
    "-m",
    "4G",
    "-smp",
    "4",
    "-drive",
    `format=raw,file=${disk}`,
    "-nic",
    // forward HTTPS (433) to local port 4433
    // forward SSH (22) to local port 2222
    "user,hostfwd=tcp::4433-:443,hostfwd=tcp::2222-:22",
    "-kernel",
    linux,
    "-initrd",
    initrd,
    "-append",
    `live.password=${password}`,
    "-cdrom",
    options.iso,
  ]);
} finally {
  if (tmpdir) {
    fs.rmSync(tmpdir, { recursive: true });
  }
}
