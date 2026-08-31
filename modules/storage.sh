#!/usr/bin/env bash
# Data store: adopt an existing RAID, create a new RAID 1, use a single disk, or
# simply share a directory that already exists.
#
# Creating a RAID is the only step in the whole installer that destroys data, so
# it sits behind several gates:
#   - system and mounted disks are never offered
#   - the contents of every candidate disk are shown first
#   - the device name has to be typed out; picking a number is not enough
#   - finally a literal confirmation phrase

STORAGE_MODE=""
SHARE_PATH=""
RAID_DEVICE=""

# Disks that must never be touched: anything carrying / or /boot.
_system_disks() {
    local mount source
    for mount in / /boot /boot/firmware; do
        source=$(findmnt -no SOURCE --target "$mount" 2>/dev/null) || continue
        lsblk -no PKNAME "$source" 2>/dev/null
        printf '%s\n' "$(basename "$source" | sed 's/p\?[0-9]*$//')"
    done | sort -u | grep -v '^$'
}

_disk_in_use() {
    local disk=$1
    # Any partition mounted? Hands off.
    lsblk -no MOUNTPOINT "/dev/$disk" 2>/dev/null | grep -q . && return 0
    # Part of an active array?
    grep -q "\b${disk}[0-9]*\[" /proc/mdstat 2>/dev/null && return 0
    return 1
}

_candidate_disks() {
    local system_disks disk
    system_disks=$(_system_disks)
    while read -r disk; do
        [[ -z $disk ]] && continue
        grep -qx "$disk" <<<"$system_disks" && continue
        _disk_in_use "$disk" && continue
        printf '%s\n' "$disk"
    done < <(lsblk -dn -o NAME,TYPE | awk '$2=="disk"{print $1}')
}

_show_disks() {
    log_raw ""
    log_raw "    ${C_BOLD}$(t 'Available disks')${C_RESET}"
    log_raw ""
    lsblk -o NAME,SIZE,MODEL,FSTYPE,LABEL,MOUNTPOINT | sed 's/^/      /' | while IFS= read -r line; do
        log_raw "$line"
    done
    log_raw ""
    log_raw "    ${C_DIM}$(t 'System and mounted disks are not offered.')${C_RESET}"
}

_existing_arrays() {
    lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="raid1"||$2=="raid0"||$2=="raid5"{print $1}'
}

# ── Creating a RAID ──────────────────────────────────────────────────────────

_describe_disk() {
    local disk=$1
    local size model
    size=$(lsblk -dn -o SIZE "/dev/$disk" 2>/dev/null | tr -d ' ')
    model=$(lsblk -dn -o MODEL "/dev/$disk" 2>/dev/null | sed 's/[[:space:]]*$//')
    log_raw "      ${C_BOLD}/dev/$disk${C_RESET}  $size  ${model:-$(t 'no model reported')}"
    local content
    content=$(lsblk -n -o NAME,SIZE,FSTYPE,LABEL "/dev/$disk" 2>/dev/null | tail -n +2)
    if [[ -n $content ]]; then
        log_raw "        ${C_YELLOW}$(t 'Already contains:')${C_RESET}"
        printf '%s\n' "$content" | while IFS= read -r line; do log_raw "          $line"; done
    else
        log_raw "        ${C_DIM}$(t 'no recognisable partitions')${C_RESET}"
    fi
}

_create_raid1() {
    local -a candidates=()
    mapfile -t candidates < <(_candidate_disks)

    if [[ ${#candidates[@]} -lt 2 ]]; then
        die "$(t 'A RAID 1 needs two free disks, found: %s' "${#candidates[@]}")"
    fi

    _show_disks
    log_raw "    ${C_BOLD}$(t 'Candidates:')${C_RESET} ${candidates[*]}"
    log_raw ""

    local disk_a="" disk_b=""
    ask disk_a "$(t 'First disk (device name without /dev/, e.g. %s)' "${candidates[0]}")"
    ask disk_b "$(t 'Second disk (device name without /dev/, e.g. %s)' "${candidates[1]}")"
    disk_a=${disk_a#/dev/}; disk_b=${disk_b#/dev/}

    [[ $disk_a == "$disk_b" ]] && die "$(t 'Two different disks are required.')"
    local d
    for d in "$disk_a" "$disk_b"; do
        [[ -b /dev/$d ]] || die "$(t '/dev/%s is not a block device.' "$d")"
        grep -qx "$d" <<<"$(_system_disks)" && die "$(t '/dev/%s belongs to the system - refused.' "$d")"
        _disk_in_use "$d" && die "$(t '/dev/%s is mounted or part of an array - refused.' "$d")"
        grep -qx "$d" <<<"$(printf '%s\n' "${candidates[@]}")" \
            || die "$(t '/dev/%s is not available as a free disk.' "$d")"
    done

    log_raw ""
    log_raw "    ${C_RED}${C_BOLD}$(t 'All data on these two disks will be destroyed:')${C_RESET}"
    log_raw ""
    _describe_disk "$disk_a"
    _describe_disk "$disk_b"
    log_raw ""

    if ! interactive; then
        die "$(t 'Creating a RAID is blocked in unattended mode.')"
    fi

    local answer
    local phrase
    phrase="$(t 'ERASE') $disk_a $disk_b"
    read -r -p "    $(t 'To confirm, type: %s' "$phrase")
    > " answer
    [[ $answer == "$phrase" ]] || die "$(t 'Aborted - the input did not match.')"

    RAID_DEVICE=/dev/md0
    local n=0
    while [[ -e $RAID_DEVICE ]]; do
        ((n++)); RAID_DEVICE=/dev/md$n
        [[ $n -gt 9 ]] && die "$(t 'No free md device name available.')"
    done

    ensure_packages mdadm
    log_info "$(t 'Creating RAID 1 %s from /dev/%s and /dev/%s' "$RAID_DEVICE" "$disk_a" "$disk_b")"
    run wipefs -a "/dev/$disk_a" "/dev/$disk_b"
    run mdadm --create --verbose "$RAID_DEVICE" --level=1 --raid-devices=2 \
        --metadata=1.2 "/dev/$disk_a" "/dev/$disk_b" --run
    run mkfs.ext4 -F -L nasdata "$RAID_DEVICE"

    # Without this entry the array is reassembled under a changing name after a
    # reboot.
    log_info "$(t 'Recording the array in mdadm.conf')"
    if ! is_dry_run; then
        mdadm --detail --scan | grep -F "$RAID_DEVICE" >>/etc/mdadm/mdadm.conf
        update-initramfs -u >/dev/null 2>&1 || log_warn "$(t 'update-initramfs failed')"
    fi
    log_ok "$(t 'RAID 1 created. Synchronisation continues in the background.')"
    log_info "$(t 'Progress: cat /proc/mdstat')"
}

# ── Single disk ──────────────────────────────────────────────────────────────

_prepare_single_disk() {
    local -a candidates=()
    mapfile -t candidates < <(_candidate_disks)
    [[ ${#candidates[@]} -eq 0 ]] && die "$(t 'No free disk found.')"

    _show_disks
    log_raw "    ${C_BOLD}$(t 'Candidates:')${C_RESET} ${candidates[*]}"

    local disk=""
    ask disk "$(t 'Disk (device name without /dev/, e.g. %s)' "${candidates[0]}")"
    disk=${disk#/dev/}
    [[ -b /dev/$disk ]] || die "$(t '/dev/%s is not a block device.' "$disk")"
    grep -qx "$disk" <<<"$(_system_disks)" && die "$(t '/dev/%s belongs to the system - refused.' "$disk")"
    _disk_in_use "$disk" && die "$(t '/dev/%s is mounted - refused.' "$disk")"

    local existing_fs
    existing_fs=$(lsblk -no FSTYPE "/dev/$disk" | grep -v '^$' | head -1)
    if [[ -n $existing_fs ]]; then
        log_raw ""
        _describe_disk "$disk"
        log_raw ""
        if confirm "$(t 'Keep the existing file system and just mount it?')" y; then
            RAID_DEVICE=/dev/$disk
            local part
            part=$(lsblk -lno NAME,TYPE "/dev/$disk" | awk '$2=="part"{print $1; exit}')
            [[ -n $part ]] && RAID_DEVICE=/dev/$part
            log_ok "$(t 'Mounting the existing file system on %s.' "$RAID_DEVICE")"
            return 0
        fi
        interactive || die "$(t 'Formatting is blocked in unattended mode.')"
        local answer
        local phrase
        phrase="$(t 'ERASE') $disk"
        read -r -p "    $(t 'To format, type: %s' "$phrase")
    > " answer
        [[ $answer == "$phrase" ]] || die "$(t 'Aborted.')"
    fi

    RAID_DEVICE=/dev/$disk
    run wipefs -a "$RAID_DEVICE"
    run mkfs.ext4 -F -L nasdata "$RAID_DEVICE"
    log_ok "$(t 'File system created on %s' "$RAID_DEVICE")"
}

# ── fstab ────────────────────────────────────────────────────────────────────

_mount_device() {
    local device=$1 mountpoint=$2
    local uuid
    uuid=$(blkid -s UUID -o value "$device" 2>/dev/null) || true
    if [[ -z $uuid ]]; then
        is_dry_run || die "$(t 'No UUID for %s - was the file system created?' "$device")"
        uuid="DRYRUN-UUID"
    fi

    ensure_dir "$mountpoint" 0775 root:root

    # UUID rather than device name: /dev/sdX is not stable across reboots.
    # nofail so a broken array cannot stop the Pi from booting.
    local line="UUID=$uuid  $mountpoint  ext4  defaults,noatime,nofail  0  2"
    if grep -q "[[:space:]]${mountpoint}[[:space:]]" /etc/fstab 2>/dev/null; then
        if grep -qF "UUID=$uuid" /etc/fstab; then
            log_skip "$(t 'fstab entry already present')"
        else
            log_info "$(t 'Updating the fstab entry for %s' "$mountpoint")"
            run sed -i "\\|[[:space:]]${mountpoint}[[:space:]]|d" /etc/fstab
            is_dry_run || printf '%s\n' "$line" >>/etc/fstab
        fi
    else
        log_info "$(t 'Adding an fstab entry for %s' "$mountpoint")"
        is_dry_run || {
            cp -a /etc/fstab /etc/fstab.phs-orig 2>/dev/null || true
            printf '%s\n' "$line" >>/etc/fstab
        }
    fi

    if ! is_dry_run; then
        mountpoint -q "$mountpoint" || mount "$mountpoint" \
            || die "$(t 'Mounting %s failed - check /etc/fstab.' "$mountpoint")"
    fi
    log_ok "$(t 'Mounted: %s' "$mountpoint")"
}

# ── Module ───────────────────────────────────────────────────────────────────

module_install() {
    STORAGE_MODE=$(state_get STORAGE_MODE)
    SHARE_PATH=$(state_get SHARE_PATH)
    RAID_DEVICE=$(state_get STORAGE_DEVICE)

    if [[ -z $STORAGE_MODE ]]; then
        local -a arrays=()
        mapfile -t arrays < <(_existing_arrays)
        local options=()
        if [[ ${#arrays[@]} -gt 0 ]]; then
            options+=("existing:$(t 'Adopt an existing RAID (found: %s)' "${arrays[*]}")")
        fi
        options+=(
            "folder:$(t 'Share an existing directory - nothing is formatted')"
            "single:$(t 'Set up a single disk')"
            "raid1:$(t 'Create a new RAID 1 from two disks (erases both)')"
        )
        ask_choice STORAGE_MODE "$(t 'How should the data store be built?')" "${options[@]}"
    fi

    case $STORAGE_MODE in
        folder)
            ask SHARE_PATH "$(t 'Path of the directory to share')" "/srv/nas"
            ensure_dir "$SHARE_PATH" 0775 root:root
            ;;
        existing)
            ensure_packages mdadm
            if [[ -z $RAID_DEVICE ]]; then
                local -a arrays=()
                mapfile -t arrays < <(_existing_arrays)
                [[ ${#arrays[@]} -eq 0 ]] && die "$(t 'No existing array found.')"
                RAID_DEVICE=/dev/${arrays[0]}
                ask RAID_DEVICE "$(t 'Array device')"
            fi
            [[ -b $RAID_DEVICE ]] || is_dry_run || die "$(t '%s is not a block device.' "$RAID_DEVICE")"
            ask SHARE_PATH "$(t 'Mount point')" "/media/nas"
            _mount_device "$RAID_DEVICE" "$SHARE_PATH"
            ;;
        single)
            [[ -n $RAID_DEVICE && -b $RAID_DEVICE ]] || _prepare_single_disk
            ask SHARE_PATH "$(t 'Mount point')" "/media/nas"
            _mount_device "$RAID_DEVICE" "$SHARE_PATH"
            ;;
        raid1)
            if [[ -n $RAID_DEVICE && -b $RAID_DEVICE ]]; then
                log_skip "$(t 'RAID already created: %s' "$RAID_DEVICE")"
            else
                _create_raid1
            fi
            ask SHARE_PATH "$(t 'Mount point')" "/media/nas"
            _mount_device "$RAID_DEVICE" "$SHARE_PATH"
            ;;
        *)
            die "$(t 'Unknown storage mode: %s' "$STORAGE_MODE")"
            ;;
    esac

    # A subdirectory rather than the mount root: if the mount ever fails, the
    # share points at an empty directory instead of the system disk, and the
    # missing files are obvious immediately.
    local data_dir="$SHARE_PATH/data"
    ensure_dir "$data_dir" 0775 root:root

    if ! is_dry_run; then
        state_set STORAGE_MODE "$STORAGE_MODE"
        state_set SHARE_PATH "$SHARE_PATH"
        state_set SHARE_DATA_DIR "$data_dir"
        [[ -n $RAID_DEVICE ]] && state_set STORAGE_DEVICE "$RAID_DEVICE"
    fi

    log_ok "$(t 'Data store ready: %s' "$data_dir")"
    if [[ $STORAGE_MODE == raid1 || $STORAGE_MODE == existing ]]; then
        log_info "$(t 'RAID status: %s array(s); details with cat /proc/mdstat' "$(grep -c '^md' /proc/mdstat 2>/dev/null || echo 0)")"
    fi
}

module_remove() {
    # Deliberately non-destructive: the fstab entry goes, the data and the array
    # stay. An installer that deletes user data on removal would be a trap.
    local mountpoint
    mountpoint=$(state_get SHARE_PATH)
    if [[ -n $mountpoint ]] && grep -q "[[:space:]]${mountpoint}[[:space:]]" /etc/fstab 2>/dev/null; then
        log_info "$(t 'Removing the fstab entry for %s' "$mountpoint")"
        run sed -i "\\|[[:space:]]${mountpoint}[[:space:]]|d" /etc/fstab
    fi
    log_warn "$(t 'Data and array are left untouched at %s.' "$mountpoint")"
    log_info "$(t 'Unmount if you want to: sudo umount %s' "$mountpoint")"
}
