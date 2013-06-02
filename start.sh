#!/bin/sh
eval `heroku config | grep : | grep -v PATH: | grep -v NODE_ENV: | sed -e "s/^\([A-Z_]*\):\s*\(.*\)/export \1=\'\2\'/"`
node monkey.js
