#!/bin/sh
# T-18: a production UI build for the lab, unminified so component names stay
# readable in render attribution. Never writes web/dist.
#   acceptance/typing/build-web.sh LABEL   ->  target/t18/web/LABEL
cd "$(dirname "$0")/../../web" || exit 2
npx vite build --minify false --outDir "../target/t18/web/${1:?label}" --emptyOutDir --logLevel warn
