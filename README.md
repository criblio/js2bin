# js2bin
NodeJS application to native executable

# What is it?
`js2bin` is a command line utility that helps package a bundled (think `webpack`, `rollup` etc) NodeJS application into a native executable. See [How it works][How it works] for more info. 

## Why do I care?
Shipping a native binary has a number of benefits over shipping a bundled `.js` file

Benefits for you
* control over NodeJS version your code runs on 
* develop for a NodeJS version that best fits your usecase
* stronger code obfuscation than what `UglifyJS` can provide
* reduced burden on supporting older versions of NodeJS 
** decide to upgrade NodeJS based on your app's version
* reduced docs needs showing users how to install `node` (on some platforms it can be a challenge) 

Benefits for your user/customer:
* quick getting started experience 
* reduced burden by not requiring installation/upgrade `node/npm` 

# Quick getting started?

Note all options to `js2bin` take the form `--option` or `--option=value`

Make an executable of your application for MacOS:

```
js2bin --build --platform=darwin --node=10.16.0 --app=/path/to/my/app.js --name=CoolAppName
```
this will create a file named `CoolAppName-darwin-x64` on your current working directory - if you're on a Mac you'll be able to execute it. Go ahead try it!


# How it works?
 
