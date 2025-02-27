# Publishing to Obsidian Community Plugins

This document outlines the steps to publish the Google Calendar Sync plugin to the Obsidian Community Plugins directory.

## Prerequisites

1. The plugin must be fully tested and working
2. The plugin must follow Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
3. You must have a GitHub repository for the plugin

## Steps to Publish

### 1. Prepare Your Release

1. Update the version number in `package.json`
2. Run `npm run version` to update the version in manifest.json and versions.json
3. Update the changelog in README.md
4. Commit your changes: `git commit -am "Prepare for release x.y.z"`
5. Create a tag: `git tag -a x.y.z -m "Release x.y.z"`
6. Push changes and tags: `git push && git push --tags`

### 2. Create a GitHub Release

The GitHub Actions workflow will automatically create a release when you push a tag.

Alternatively, you can manually create a release:

1. Run `./build.sh` to build and package the plugin
2. Go to your GitHub repository and create a new release
3. Upload the `obsidian-gcal-sync.zip` file, main.js, manifest.json, and styles.css

### 3. Submit to Obsidian Community Plugins

1. Fork the [obsidian-releases](https://github.com/obsidianmd/obsidian-releases) repository
2. Add your plugin to the `community-plugins.json` file:
   ```json
   {
     "id": "obsidian-gcal-sync",
     "name": "Google Calendar Sync",
     "author": "Sasoon Sarkisian",
     "description": "Sync Obsidian tasks with Google Calendar",
     "repo": "sasoon/obsidian-gcal-sync",
     "branch": "main"
   }
   ```
3. Create a pull request to the obsidian-releases repository

### 4. Wait for Approval

The Obsidian team will review your plugin. They may request changes before approving it.

## Updating the Plugin

1. Make your changes
2. Update the version number in `package.json`
3. Run `npm run version` to update the version in manifest.json and versions.json
4. Update the changelog in README.md
5. Commit, tag, and push as described above

The new version will automatically be available to users once the GitHub release is created. 