#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/opensuse-microos-containerhost.yaml"
VMS=(test1 test2 test3)

# Lima can't find OVMF on openSUSE because the package names it
# ovmf-x86_64-4m-code.bin instead of edk2-x86_64-code.fd. Symlink into the
# user-local path Lima checks.
FW_LINK="$HOME/.local/share/qemu/edk2-x86_64-code.fd"
FW_SRC="/usr/share/qemu/ovmf-x86_64-4m.bin"
mkdir -p "$(dirname "$FW_LINK")"
ln -sf "$FW_SRC" "$FW_LINK"

for vm in "${VMS[@]}"; do
    if limactl ls -q | grep -qx "$vm"; then
        echo "[$vm] already exists, starting if stopped"
        limactl start --network=lima:user-v2 "$vm"
    else
        echo "[$vm] creating and starting"
        limactl start --network=lima:user-v2 --tty=false --containerd=none --name="$vm" "$TEMPLATE"
    fi
done

limactl ls
