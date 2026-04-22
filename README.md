# js2bin
NodeJS application to native executable

# What is it?
`js2bin` is a command line utility that helps package a bundled (think `webpack`, `rollup` etc) NodeJS application into a native executable. See [How it works](#how-it-works) for more info. 

## Why do I care?
Shipping a native binary has a number of benefits over shipping a bundled `.js` file

Benefits for you
* control over NodeJS version your code runs on 
* develop for a NodeJS version that best fits your usecase
* stronger code obfuscation than what `UglifyJS` can provide
* reduced burden on supporting older versions of NodeJS 
    * decide to upgrade NodeJS based on your app's version
* reduced docs needs showing users how to install `node` (on some platforms it can be a challenge) 

Benefits for your user/customer:
* quick getting started experience 
* reduced burden by not requiring installation/upgrade `node/npm` 

# Quick getting started?

NOTE:
* all CLI  options to `js2bin` take the form `--option` or `--option=value`
* certain options can be arrays in such case provide the option multiple times, e.g. `--option=a --option=b`

## Executable for one platform
Make an executable of your application for MacOS:

```
js2bin --build --platform=darwin --node=10.16.0 --app=/path/to/my/app.js --name=CoolAppName
```
this will create a file named `CoolAppName-darwin-x64` on your current working directory - if you're on a Mac you'll be able to execute it. Go ahead try it!

## Executable for > 1 platform
Make an executable of your application for MacOS and Linux:

```
js2bin --build --platform=darwin --platform=linux --node=10.16.0 --app=/path/to/my/app.js --name=CoolAppName
```
this will create 2 files named `CoolAppName-darwin-x64` and `CoolAppName-linux-x64` on your current working directory - if you're on Mac  or Linux you'll be able to execute either of them. Go ahead try it!

## Build for your version of Node
In case where you want to build for a version of Node for which a prebuild binary does not exist you'll need to follow a 2 step process
1. create a build with a placeholder (this will download NodeJS source, build it locally and add the build to the local cache)
```
js2bin --ci --cache --node=10.13.0 --size=2MB
```
2. bundle your application into the just built binary
```
js2bin --build --cache --node=10.13.0 --app=/path/to/my/app.js --name=CoolAppName
```

# CLI Options

```
--help: print this help message

--build: embed your application into the precompiled NodeJS binary.
  --node:     NodeJS version(s) to use, can specify more than one. 
              e.g. --node=10.16.0 --node=12.4.0
  --platform: Platform(s) to build for, can specifiy more than one. 
              e.g. --platform=linux --plaform=darwin
  --app:      Path to your (bundled) application. 
              e.g. --app=/path/to/app/index.js
  --name:     Application name (optional)
  --dir:      (opt) Working directory, if not specified use cwd
              e.g. --dir=/tmp/js2bin
  --cache     (opt) Cache any pre-built binaries used, to avoid redownload
  --enable-overlay: (opt) Use an overlay-enabled cached binary. Requires a cached
                    binary built with --enable-overlay via --ci.
  --signing-public-key: Embed an ECDSA P-256 public key into the binary.
                Required with --enable-overlay.

--overlay: build a signed overlay bundle from a JS application
  --app:         Path to your (bundled) application
  --signing-key: Path to ECDSA P-256 private key PEM file for signing
  --output:      (opt) Output directory (default: ./overlay-bundle/)

--ci: build NodeJS with preallocated space for embedding applications
  --node: NodeJS version to build from source, can specify more than one. 
          e.g. --node=10.16.0
  --size: Amount of preallocated space, can specify more than one. 
          e.g. --size=2MB --size==4MB
  --dir:    (opt) Working directory, if not specified use cwd
  --cache:  (opt) whether to keep build in the cache (to be reused by --build)
  --upload: (opt) whether to upload node build to github releases
  --clean:  (opt) whether to clean up after the build
  --enable-overlay: (opt) Compile the overlay runtime into the binary. The resulting
                    binary has no embedded signing key — consumers stamp their own
                    in at --build time via --signing-public-key.


```

# Overlay Updates

js2bin supports overlay updates, allowing you to ship updated JavaScript to existing binaries without rebuilding them. **Overlay support is completely opt-in** — by default, no overlay code exists in the binary. You must explicitly enable it at build time.

## How it works

When a binary is built with `--enable-overlay`, it checks for a signed overlay bundle at startup. If a valid bundle is found, it runs that instead of the embedded app. If no bundle is found (or the signature is invalid), it falls back to the embedded app. The binary will never run unsigned or tampered code.

## Building an overlay-enabled binary

Overlay-enabled binaries must be built from source because the overlay runtime needs to be compiled into Node. The signing public key is embedded at **`--build`** time, so the placeholder binaries published by this project (and any cached via `--ci`) carry no baked-in key — every consumer stamps in their own:

```bash
# 1. Build Node from source with overlay support (slow, one-time). No key yet.
js2bin --ci --node=22.22.0 --size=2MB --cache --enable-overlay

# 2. Embed your app AND your signing public key into the overlay-enabled cached
#    binary (fast). --signing-public-key is required with --enable-overlay.
js2bin --build --app=/path/to/app.js --node=22.22.0 --cache --enable-overlay \
  --signing-public-key=overlay-signing.pub --name=MyApp
```

Because step 1 produces a keyless artifact, the overlay-enabled binaries published to GitHub releases can be reused by anyone: download, run `--build` with your own key, ship.

## Creating an overlay update bundle

```bash
js2bin --overlay --app=/path/to/updated-app.js --signing-key=overlay-signing.key --output=./overlay-bundle/
```

This produces three artifacts:
- `bundle.js` — brotli-compressed, base64-encoded JavaScript
- `bundle.js.sig` — ECDSA P-256 signature (DER-encoded)
- `bundle.js.sha256` — SHA-256 checksum

## Deploying an overlay update

Place the bundle artifacts where the binary will find them:

```
<binary-dir>/
  myapp                    ← your overlay-enabled binary
  overlay/
    current/
      bundle.js            ← overlay bundle
      bundle.js.sig        ← signature
```

The binary looks for bundles at `<binary-dir>/overlay/current/` by default. Override this with the `JS2BIN_OVERLAY_DIR` environment variable.

## Signature verification

The binary verifies overlay bundles using ECDSA P-256 (SHA-256) against the public key stamped into the binary at `--build` time via `--signing-public-key`. That embedded key is the only accepted verifier — there is no on-disk key loading.

If signature verification fails, the binary falls back to the embedded app and logs a warning to stderr.

## Generating signing keys

```bash
# Generate ECDSA P-256 private key
openssl ecparam -name prime256v1 -genkey -noout -out overlay-signing.key

# Extract public key
openssl ec -in overlay-signing.key -pubout -out overlay-signing.pub
```

# Code changes 

While we've tried to minimize the amount of code changes needed when developing and testing using `node` and shipping a native binary, there are a few things you need to keep in mind:
1. `process.argv` - `js2bin` inserts and fake argument in `process.argv[1] = cwd()/<app-name>.js`. This ensures minimal code changes, but if your application depends on using that file (highly unlikely) that file won't be there.
2. `child_process.fork` - if you're application uses this NodeJS specific forking method (to spawn more copies of itself) then you'll need to distinguish between `node` mode and bundled app -
```
  if(path.basename(process.execPath) === 'node') {
    child_process.fork(....)
  } else {
    child_process.spawn(process.execPath, ...)
  }
```

# How it works?

NodeJS provides **compile time** hooks for changing the behavior of the resulting binary, usually `node`. This is done by allowing users to (a) place their code in `lib/_third_party_main.js`, (b) modifying `node.gyp` to include that file in the build and then recompile. Once `node` is compiled, at startup controll will be passed to `lib/_third_party_main.js` as early as possible. There are some caveats tho:
1. few options that are handled before control is handed over (e.g. `--version`) 
2. few modules (like `clustering`) that are not set up
3. contents of `process.argv` would be different when your app is started this way (only relevant if you want to develop using `node` but ship your app bundled up)

While the above is pretty straightforward it suffers from two problems:
1. need to recompile `node` after every change to your application 
2. recompiling `node` can take time - think 20+ minutes (if you're on a laptop) - thus, less than ideal development experience.

Now, imagine if we changed the `node` build process to be a two step process:
1. compile `node` with some placeholder content, large enought to fit our application and cache it. 
2. build our application by inserting it into the pre-compiled binary from (1).

This is exactly what `js2bin` does - with the following specs/modifications:
1. `node` binaries are prebuilt for a number of platforms with placeholder content for 2 and 4MB in size
2. the contents of the embedded application are compressed and base64 encoded. (why? because when embedding a JS script that has chars outside the ASCII range the **entire** script is stored using UCS-2/UTF-16 for storing the script, thus doubling in size. This is common when you bundle up char conversion libraries that contain pregenerated tables - e.g. is the popular [iconv-lite](https://www.npmjs.com/package/iconv-lite) )



