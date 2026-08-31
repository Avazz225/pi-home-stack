#!/usr/bin/env bash
# Interactive prompts.
#
# Deliberately plain read/printf instead of whiptail: this runs over SSH on a fresh
# Pi OS Lite, has to work when the terminal is dumb, and every answer must also be
# reachable non-interactively so the whole installer can run unattended.

ASSUME_YES=${ASSUME_YES:-0}
UNATTENDED=${UNATTENDED:-0}

interactive() { [[ $UNATTENDED == 0 && -t 0 ]]; }

# ask VAR "Question" "default"
# An existing non-empty value of VAR wins over the built-in default, so --flags and
# the state file are simply offered back to the user for confirmation.
ask() {
    local var=$1 prompt=$2 default=${3:-}
    local current=${!var:-}
    [[ -n $current ]] && default=$current

    if ! interactive; then
        [[ -z $default ]] && die "$(t 'Non-interactive run with no value for %s' "$var")"
        printf -v "$var" '%s' "$default"
        return 0
    fi

    local answer
    if [[ -n $default ]]; then
        read -r -p "    $prompt [$default]: " answer
        answer=${answer:-$default}
    else
        while :; do
            read -r -p "    $prompt: " answer
            [[ -n $answer ]] && break
            log_warn "$(t 'Please enter a value.')"
        done
    fi
    printf -v "$var" '%s' "$answer"
}

# Password prompt with confirmation. Never echoes, never lands in shell history.
ask_secret() {
    local var=$1 prompt=$2 allow_generate=${3:-0}
    local current=${!var:-}
    [[ -n $current ]] && return 0

    if ! interactive; then
        if [[ $allow_generate == 1 ]]; then
            printf -v "$var" '%s' "$(random_password 24)"
            return 0
        fi
        die "$(t 'Non-interactive run with no password for %s' "$var")"
    fi

    local first second
    while :; do
        if [[ $allow_generate == 1 ]]; then
            read -r -s -p "    $prompt $(t '(empty = generate one)'): " first
        else
            read -r -s -p "    $prompt: " first
        fi
        echo
        if [[ -z $first && $allow_generate == 1 ]]; then
            first=$(random_password 24)
            log_info "$(t 'Generated a random password.')"
            break
        fi
        if [[ ${#first} -lt 8 ]]; then
            log_warn "$(t 'At least 8 characters, please.')"
            continue
        fi
        read -r -s -p "    $(t 'Repeat'): " second
        echo
        [[ $first == "$second" ]] && break
        log_warn "$(t 'Passwords do not match.')"
    done
    printf -v "$var" '%s' "$first"
}

# confirm "Question?" [default y|n]
confirm() {
    local prompt=$1 default=${2:-n}
    [[ $ASSUME_YES == 1 ]] && return 0
    if ! interactive; then
        [[ $default == y ]]
        return
    fi
    local hint yes_char no_char answer
    yes_char=$(t 'y')
    no_char=$(t 'n')
    if [[ $default == y ]]; then
        hint="[${yes_char^^}/${no_char}]"
    else
        hint="[${yes_char}/${no_char^^}]"
    fi
    read -r -p "    $prompt $hint " answer
    answer=${answer,,}
    answer=${answer:-$default}
    # Accept the English letters as well, so a German session still understands "y".
    [[ $answer == "$yes_char" || $answer == y || $answer == yes || $answer == ja ]]
}

# ask_choice VAR "Question" "value:Label" "value:Label" ...
ask_choice() {
    local var=$1 prompt=$2
    shift 2
    local options=("$@")
    local current=${!var:-}

    if [[ -n $current ]]; then
        local opt
        for opt in "${options[@]}"; do
            [[ ${opt%%:*} == "$current" ]] && return 0
        done
    fi

    if ! interactive; then
        [[ -n $current ]] || printf -v "$var" '%s' "${options[0]%%:*}"
        return 0
    fi

    log_raw ""
    log_raw "    $prompt"
    local i=1 opt
    for opt in "${options[@]}"; do
        log_raw "      $i) ${opt#*:}"
        ((i++))
    done
    local answer
    while :; do
        read -r -p "    $(t 'Choice') [1]: " answer
        answer=${answer:-1}
        if [[ $answer =~ ^[0-9]+$ ]] && (( answer >= 1 && answer <= ${#options[@]} )); then
            printf -v "$var" '%s' "${options[$((answer - 1))]%%:*}"
            return 0
        fi
        log_warn "$(t 'Please enter a number between 1 and %s.' "${#options[@]}")"
    done
}

# Multi-select over the feature list.
ask_features() {
    local -n _defs=$1
    local -n _chosen=$2
    local id label state line answer
    _chosen=()

    log_raw ""
    log_raw "    ${C_BOLD}$(t 'Which components should be set up?')${C_RESET}"
    log_raw "    ${C_DIM}$(t 'Already installed ones are preselected; selecting them again repairs or updates them.')${C_RESET}"
    log_raw ""

    local -a ids=()
    local i=1
    for line in "${_defs[@]}"; do
        id=${line%%:*}
        label=${line#*:}
        # Hidden until its precondition is met - see FEATURE_OFFER_IF.
        if declare -F feature_offered >/dev/null && ! feature_offered "$id"; then
            continue
        fi
        ids+=("$id")
        if feature_installed "$id"; then
            state="${C_GREEN}$(t 'installed')${C_RESET}"
            _chosen+=("$id")
        else
            state="${C_DIM}$(t 'not installed')${C_RESET}"
        fi
        log_raw "      $i) ${C_BOLD}$id${C_RESET} — $(t "$label")  ($state)"
        ((i++))
    done

    local all_word
    all_word=$(t 'all')
    log_raw ""
    log_raw "    $(t 'Numbers separated by spaces, %s for everything,' "${C_BOLD}${all_word}${C_RESET}")"
    log_raw "    $(t 'or Enter to keep the current selection.')"
    read -r -p "    $(t 'Choice'): " answer

    [[ -z $answer ]] && return 0

    if [[ ${answer,,} == "$all_word" || ${answer,,} == all ]]; then
        _chosen=("${ids[@]}")
        return 0
    fi

    local -a picked=()
    local n
    for n in $answer; do
        if [[ $n =~ ^[0-9]+$ ]] && (( n >= 1 && n <= ${#ids[@]} )); then
            picked+=("${ids[$((n - 1))]}")
        else
            log_warn "$(t 'Ignoring invalid input: %s' "$n")"
        fi
    done
    # Installed features stay selected — deselecting is 'remove', not 'skip'.
    local already
    for already in "${_chosen[@]}"; do
        local found=0 p
        for p in "${picked[@]}"; do [[ $p == "$already" ]] && found=1; done
        [[ $found == 0 ]] && picked+=("$already")
    done
    _chosen=("${picked[@]}")
}

banner() {
    log_raw ""
    log_raw "${C_BOLD}${C_BLUE}  pi-home-stack${C_RESET}  ${C_DIM}— $(t 'Pi-hole, NAS and a home interface on one Raspberry Pi')${C_RESET}"
    log_raw "${C_DIM}  ------------------------------------------------------------------${C_RESET}"
}
