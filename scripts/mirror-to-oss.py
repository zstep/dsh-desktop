#!/usr/bin/env python3
"""Mirror the download-page desktop installers to Aliyun OSS and publish the catalog.

Reads the electron-builder release assets produced by the `publish` job and
uploads the three user-facing installers (macOS Apple Silicon, macOS Intel,
Windows x64) to the Open WebUI OSS bucket under a versioned flat key, then
writes the ``catalog.json`` that the /download page consumes. The object
layout matches open-webui's ``routers/desktop_downloads.py`` contract:

    pengbao/desktop/catalog.json
    pengbao/desktop/pengbao-ai-<version>-mac-arm64.dmg
    pengbao/desktop/pengbao-ai-<version>-mac-x64.dmg
    pengbao/desktop/pengbao-ai-<version>-windows-x64-setup.exe

Versioned filenames keep a stable download URL from ever re-serving old bytes
through a CDN/browser cache. The client's auto-update feed continues to be
served from dshdesktop.com (this mirror only feeds the public download page).

Credentials reuse the same S3 environment as open-webui's STORAGE_PROVIDER=s3:
    S3_ENDPOINT_URL, S3_REGION_NAME, S3_BUCKET_NAME, S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY, and optional S3_ADDRESSING_STYLE.

boto3 must be <1.36: Aliyun OSS rejects the flexible-checksum aws-chunked
trailer (STREAMING-UNSIGNED-PAYLOAD-TRAILER) that newer botocore emits for
multipart PutObject/UploadPart, and a 300 MB+ DMG always uploads multipart.
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import boto3
from botocore.config import Config

# id -> artifact filename, matching package.json "build".artifactName/nsis.
INSTALLERS = {
    "mac-arm64": "pengbao-ai-mac-arm64.dmg",
    "mac-x64": "pengbao-ai-mac-x64.dmg",
    "windows-x64": "pengbao-ai-windows-x64-setup.exe",
}

_CONTENT_TYPES = {
    ".dmg": "application/x-apple-diskimage",
    ".zip": "application/zip",
    ".exe": "application/x-msdownload",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def versioned_name(version: str, filename: str) -> str:
    """pengbao-ai-mac-arm64.dmg -> pengbao-ai-<version>-mac-arm64.dmg (safe flat key)."""
    prefix = "pengbao-ai-"
    if filename.startswith(prefix):
        return f"{prefix}{version}-{filename[len(prefix):]}"
    return f"{prefix}{version}-{filename}"


def content_type(filename: str) -> str:
    lowered = filename.lower()
    for ext, media in _CONTENT_TYPES.items():
        if lowered.endswith(ext):
            return media
    return "application/octet-stream"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, help="release-assets directory")
    parser.add_argument("--version", required=True, help="release version without the v prefix")
    args = parser.parse_args()

    required = ["S3_ENDPOINT_URL", "S3_REGION_NAME", "S3_BUCKET_NAME", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print(f"::error::missing OSS environment: {', '.join(missing)}")
        return 1

    desktop_prefix = "pengbao/desktop"
    bucket = os.environ["S3_BUCKET_NAME"]

    client = boto3.client(
        "s3",
        region_name=os.environ["S3_REGION_NAME"],
        endpoint_url=os.environ["S3_ENDPOINT_URL"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
        config=Config(s3={"addressing_style": os.environ.get("S3_ADDRESSING_STYLE", "virtual")}),
    )

    directory = Path(args.directory)
    platforms = []
    for pid, filename in INSTALLERS.items():
        source = directory / filename
        if not source.is_file():
            print(f"::warning::skipping {pid}: {filename} not found in {directory}")
            continue
        key_name = versioned_name(args.version, filename)
        key = f"{desktop_prefix}/{key_name}"
        client.upload_file(str(source), bucket, key, ExtraArgs={"ContentType": content_type(key_name)})
        platforms.append({
            "id": pid,
            "filename": key_name,
            "size": source.stat().st_size,
            "sha256": sha256(source),
        })
        print(f"uploaded {key} ({source.stat().st_size} bytes)")

    if not platforms:
        print("::error::no desktop installers found; nothing mirrored to OSS")
        return 1

    catalog = {"version": args.version, "platforms": platforms}
    catalog_key = f"{desktop_prefix}/catalog.json"
    client.put_object(
        Bucket=bucket,
        Key=catalog_key,
        Body=json.dumps(catalog, indent=2, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    print(f"uploaded {catalog_key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())