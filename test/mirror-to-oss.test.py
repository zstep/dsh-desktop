"""Run with python3 -I test/mirror-to-oss.test.py; no cloud access required."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

# Stub the SDK at the boundary; production code is exercised with an in-memory S3.
boto3 = types.ModuleType('boto3')
config = types.ModuleType('botocore.config')
config.Config = lambda **kwargs: kwargs
with patch.dict(sys.modules, {'boto3': boto3, 'botocore': types.ModuleType('botocore'), 'botocore.config': config}):
    spec = importlib.util.spec_from_file_location('mirror', Path(__file__).resolve().parents[1] / 'scripts/mirror-to-oss.py')
    mirror = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mirror)


class FakeS3:
    def __init__(self, corrupt=False):
        self.objects = {}
        self.catalog = None
        self.corrupt = corrupt

    def upload_file(self, source, bucket, key, ExtraArgs):
        self.objects[key] = Path(source).read_bytes()

    def get_object(self, **kwargs):
        value = self.objects[kwargs['Key']]
        return {'Body': io.BytesIO(value + b'corruption' if self.corrupt else value)}

    def put_object(self, **kwargs):
        self.catalog = json.loads(kwargs['Body'])


class MirrorTests(unittest.TestCase):
    def run_mirror(self, directory, client):
        env = {name: 'fixture' for name in ['S3_ENDPOINT_URL', 'S3_REGION_NAME', 'S3_BUCKET_NAME', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']}
        with patch.dict(os.environ, env), patch.object(boto3, 'client', return_value=client, create=True), patch.object(sys, 'argv', ['mirror', '--directory', directory, '--version', '0.13.2', '--build-id', '123-1', '--source-sha', 'abc123']):
            return mirror.main()

    def populate(self, root):
        for filename in mirror.INSTALLERS.values():
            (Path(root) / filename).write_bytes(filename.encode())

    def test_missing_platform_does_not_upload_or_switch_catalog(self):
        with tempfile.TemporaryDirectory() as root:
            client = FakeS3()
            (Path(root) / next(iter(mirror.INSTALLERS.values()))).write_bytes(b'partial')
            self.assertEqual(self.run_mirror(root, client), 1)
            self.assertFalse(client.objects)
            self.assertIsNone(client.catalog)

    def test_bad_uploaded_bytes_never_switch_catalog(self):
        with tempfile.TemporaryDirectory() as root:
            self.populate(root)
            client = FakeS3(corrupt=True)
            with self.assertRaisesRegex(RuntimeError, 'catalog unchanged'):
                self.run_mirror(root, client)
            self.assertIsNone(client.catalog)

    def test_all_three_verified_then_catalog_published(self):
        with tempfile.TemporaryDirectory() as root:
            self.populate(root)
            client = FakeS3()
            self.assertEqual(self.run_mirror(root, client), 0)
            self.assertEqual(client.catalog['version'], '0.13.2')
            self.assertEqual(client.catalog['sourceSha'], 'abc123')
            self.assertEqual(len(client.catalog['platforms']), 3)
            for entry in client.catalog['platforms']:
                self.assertIn('0.13.2-123-1-', entry['filename'])
                self.assertEqual(len(entry['sha256']), 64)


if __name__ == '__main__':
    unittest.main()
