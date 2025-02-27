#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Assuming your plugin is built into a directory called "obsidian-gcal-sync"
WINDOWS_SHARE="/mnt/c/Users/sasoo/Downloads" # Change to your share path
ANDROID_PLUGIN_PATH="/storage/emulated/0/Documents/Obsidian/CONSTANT_VIGILANCE/.obsidian/plugins"
PLUGIN_NAME="obsidian-gcal-sync"

echo -e "${YELLOW}Building Obsidian Google Calendar Sync Plugin...${NC}"

# Ensure we have the latest dependencies
echo -e "${GREEN}Installing dependencies...${NC}"
npm ci

# Build the plugin
echo -e "${GREEN}Building plugin...${NC}"
npm run build

# Create plugin directory
echo -e "${GREEN}Creating plugin package...${NC}"
rm -rf $PLUGIN_NAME $PLUGIN_NAME.zip
mkdir -p $PLUGIN_NAME

# Copy files to plugin directory
cp main.js manifest.json styles.css README.md LICENSE $PLUGIN_NAME/

# Move the unzipped plugin folder to the Windows share
cp -r "$PLUGIN_NAME" "$WINDOWS_SHARE"

echo "Plugin folder moved to Windows share."

# Push to Android device using PowerShell
echo -e "${GREEN}Pushing plugin to Android device...${NC}"
powershell.exe -Command "adb push C:\\Users\\sasoo\\Downloads\\$PLUGIN_NAME $ANDROID_PLUGIN_PATH"

# Create zip file
echo -e "${GREEN}Creating zip file...${NC}"
zip -r $PLUGIN_NAME.zip $PLUGIN_NAME

# Cleanup
rm -rf $PLUGIN_NAME

echo -e "${GREEN}Build complete!${NC}"

echo -e "${YELLOW}Plugin package created at:${NC} $PLUGIN_NAME.zip"
echo -e "${YELLOW}Plugin pushed to Android device at:${NC} $ANDROID_PLUGIN_PATH" 