#!/usr/bin/env bash
set -euo pipefail

# This script is based on Bun's install script

if [[ ${OS:-} = Windows_NT ]]; then
    echo 'error: install synapse using Windows Subsystem for Linux or use the Powershell script'
    exit 1
fi

Color_Off=''
Red=''
Green=''
Dim=''

if [[ -t 1 ]]; then
    Color_Off='\033[0m'
    Red='\033[0;31m'
    Green='\033[0;32m'
    Dim='\033[0;2m'   
fi

error() {
    echo -e "${Red}error${Color_Off}:" "$@" >&2
    exit 1
}

info() {
    echo -e "${Dim}$@ ${Color_Off}"
}

info_log() {
    echo -e "${Dim}$@ ${Color_Off}" >&2
}

success() {
    echo -e "${Green}$@ ${Color_Off}"
}

# Used for script generation
DownloadUrl=''
if [ -n "$DownloadUrl" ]; then
    set -- "$DownloadUrl" "$@"
fi

InstallToProfile=${SYNAPSE_INSTALL_TO_PROFILE:-true}

install_dir=${SYNAPSE_INSTALL:-$HOME/.synapse}
app_dir=$install_dir/app

if [[ ! -d "$app_dir" ]]; then
    mkdir -p "$app_dir" ||
        error "Failed to create install directory \"$app_dir\""
fi

get_target() {
    case $(uname -ms) in
    'Darwin x86_64')
        # Is this process running in Rosetta?
        # redirect stderr to devnull to avoid error message when not running in Rosetta
        if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null) = 1 ]]; then
            info_log "Your shell is running in Rosetta 2. Downloading synapse for $target instead"
            echo darwin-aarch64
        else
            echo darwin-x64
        fi
        ;;
    'Darwin arm64')
        echo darwin-aarch64
        ;;
    'Linux aarch64' | 'Linux arm64')
        error "ARM on Linux is not supported yet" # FIXME
        echo linux-aarch64
        ;;
    'Linux x86_64' | *)
        echo linux-x64
        ;;
    esac
}

install_from_archive() {
    strip=0
    case $(basename $1) in
        *.xz         ) flags=-Jxf;;
        *.gz|*.tgz   ) flags=-zxf;;
        *.zip        )
            strip=1
            flags=-zxf
            ;;
    esac

    tar --strip=$strip $flags "$1" -C "$app_dir" || error 'Failed to extract synapse'

    sea="$app_dir/bin/synapse"

    if [[ -f "$sea" ]]; then
        node=$sea
    else
        node="$app_dir/bin/node"
    fi

    chmod +x "$node"

    if [ "$InstallToProfile" = true ]; then
        shell=${SHELL:-sh}
        "$node" "$app_dir/dist/install.js" "$install_dir" "$app_dir" $(basename "$shell")
    else
        info 'Skipping profile install'
        "$node" "$app_dir/dist/install.js" "$install_dir" "$app_dir"
    fi

    installedVersion=$("$install_dir"/bin/synapse --version)
    success "Installed $installedVersion"
}

install_from_github() {
    target=$(get_target)
    if [[ "$target" =~ ^darwin ]]; then
        tarball_basename=synapse-$target.zip
    else
        tarball_basename=synapse-$target.tgz
    fi

    GITHUB=${GITHUB-"https://github.com"}

    github_repo="$GITHUB/Cohesible/synapse"

    if [[ $# = 0 ]]; then
        synapse_uri=$github_repo/releases/latest/download/$tarball_basename
    else
        info "Installing requested version $1"
        synapse_uri=$github_repo/releases/download/$1/$tarball_basename
    fi

    tarball_path=$app_dir/$tarball_basename

    curl --fail --location --progress-bar --output "$tarball_path" "$synapse_uri" ||
        error "Failed to download synapse from \"$synapse_uri\""

    install_from_archive "$tarball_path"

    rm -r "$tarball_path"
}

if [[ $# -gt 0 ]]; then
    if [[ $# -gt 1 ]]; then
        install_dir="$2"
        app_dir="$install_dir/app"

        if [[ ! -d "$app_dir" ]]; then
            mkdir -p "$app_dir" ||
                error "Failed to create install directory \"$app_dir\""
        fi

    fi

    if [[ "$1" =~ ^https: ]]; then
        target=$(get_target)
        if [[ "$target" =~ ^darwin ]]; then
            tarball_basename=synapse-$target.zip
        else
            tarball_basename=synapse-$target.tgz
        fi

        tarball_path=$app_dir/$tarball_basename

        curl --fail --location --progress-bar --output "$tarball_path" "$1" || error "Failed to download synapse from \"$1\""

        install_from_archive "$tarball_path"
        rm -r "$tarball_path"
    elif [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        install_from_github $1
    elif [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        install_from_github "v$1"
    else
        install_from_archive $1
    fi

    exit 0
fi

install_from_github
