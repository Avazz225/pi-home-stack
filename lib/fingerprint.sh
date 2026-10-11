#!/usr/bin/env bash
# Content fingerprints, so an update can tell what actually needs redeploying.
#
# Why a hash and not a version number in each module: a number has to be
# remembered, and the one time it is forgotten the update silently does nothing.
# A hash over the inputs cannot be forgotten. The cost is breadth — a comment
# fixed in a module counts as a change — but a redeploy is cheap by design:
# write_file notices identical content and restart_if_changed only restarts when
# a file really moved.
#
# What goes in:
#   * the module itself
#   * lib/, because a change there can change every file a module renders
#   * every template and asset directory the module names literally
#   * whatever the caller adds, for relationships a grep cannot see — the four
#     service directories under apps/ are computed from a table, not spelled out
#
# Paths go into the hash next to the contents, so renaming a file counts as a
# change even when nothing inside it moved.

# feature_fingerprint <id> [extra path relative to PHS_ROOT]...
feature_fingerprint() {
    local id=$1; shift
    local module="$PHS_MODULE_DIR/$id.sh"
    [[ -f $module ]] && [[ -d ${PHS_LIB_DIR:-} ]] || { printf 'missing'; return 0; }

    local -a files=("$module")
    local f g name

    while IFS= read -r f; do
        [[ -n $f ]] && files+=("$f")
    done < <(find "$PHS_LIB_DIR" -type f \( -name '*.sh' -o -name '*.py' \) 2>/dev/null | sort)

    if [[ -d ${PHS_TEMPLATE_DIR:-} ]]; then
        for f in "$PHS_TEMPLATE_DIR"/*; do
            [[ -f $f ]] || continue
            name=$(basename "$f")
            grep -qF "$name" "$module" && files+=("$f")
        done
    fi

    if [[ -d ${PHS_ASSET_DIR:-} ]]; then
        for f in "$PHS_ASSET_DIR"/*; do
            [[ -d $f ]] || continue
            name=$(basename "$f")
            grep -qF "$name" "$module" || continue
            while IFS= read -r g; do
                [[ -n $g ]] && files+=("$g")
            done < <(find "$f" -type f 2>/dev/null | sort)
        done
    fi

    local extra
    for extra in "$@"; do
        [[ -n $extra && -e "${PHS_ROOT:-.}/$extra" ]] || continue
        while IFS= read -r g; do
            [[ -n $g ]] && files+=("$g")
        done < <(find "${PHS_ROOT:-.}/$extra" -type f 2>/dev/null | sort)
    done

    {
        for f in "${files[@]}"; do
            # Relativ zur Wurzel: ein verschobenes Checkout darf den
            # Fingerabdruck nicht aendern, ein umbenannte Datei schon.
            printf '%s\n' "${f#"${PHS_ROOT:-}"/}"
            cat "$f" 2>/dev/null
        done
    } | sha256sum | cut -c1-16
}
