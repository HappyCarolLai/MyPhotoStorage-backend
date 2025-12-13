#!/bin/bash
# 這是為了確保 Zeabur 環境安裝 FFmpeg

# 檢查是否為 Debian/Ubuntu 系統 (Zeabur Node.js 預設可能基於此)
if [ -f /etc/debian_version ]; then
    echo "使用 apt 安裝 FFmpeg..."
    apt-get update
    apt-get install -y ffmpeg
# 檢查是否為 Alpine Linux 系統
elif [ -f /etc/alpine-release ]; then
    echo "使用 apk 安裝 FFmpeg..."
    apk add --no-cache ffmpeg
else
    echo "無法識別作業系統類型，跳過 FFmpeg 安裝。"
fi