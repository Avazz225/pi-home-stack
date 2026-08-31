#!/usr/bin/env bash
# Message translation.
#
# gettext-style: the English text is itself the lookup key, so the source stays
# readable and an untranslated string degrades to English instead of printing a
# bare identifier. Catalogues live in lib/lang/<code>.sh and only need to carry
# the strings they actually translate.
#
#   log_info "$(t 'Creating directory: %s' "$dir")"
#
# Placeholders are printf-style and always come from our own catalogue, never
# from user input — the arguments are what may be untrusted, and those only ever
# land in %s.

declare -A MESSAGES=()
LANGUAGE=${LANGUAGE:-}

# Picks a language from the environment when --language was not given.
detect_language() {
    local candidate=${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}
    candidate=${candidate%%.*}
    candidate=${candidate%%_*}
    case ${candidate,,} in
        de) printf 'de' ;;
        *)  printf 'en' ;;
    esac
}

load_language() {
    local code=${1:-}
    [[ -z $code ]] && code=$(detect_language)
    LANGUAGE=${code,,}
    MESSAGES=()

    # English is the source language; there is nothing to load for it.
    [[ $LANGUAGE == en ]] && return 0

    local catalogue="${PHS_LIB_DIR}/lang/${LANGUAGE}.sh"
    if [[ ! -f $catalogue ]]; then
        printf 'Unknown language "%s", falling back to English.\n' "$LANGUAGE" >&2
        LANGUAGE=en
        return 0
    fi
    # shellcheck source=/dev/null
    source "$catalogue"
}

available_languages() {
    printf 'en\n'
    local file
    for file in "${PHS_LIB_DIR}"/lang/*.sh; do
        [[ -f $file ]] || continue
        basename "$file" .sh
    done
}

t() {
    local key=$1
    shift
    local text=${MESSAGES[$key]:-$key}
    if [[ $# -gt 0 ]]; then
        # shellcheck disable=SC2059  # the format string is ours, only args vary
        printf "$text" "$@"
    else
        printf '%s' "$text"
    fi
}
