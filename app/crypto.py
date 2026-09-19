"""密文配置项的落盘加密 / 解密（无第三方依赖的演示级实现）。

- 密文在数据库中以 ``enc:v1:...`` 前缀存储，与明文区分；
- 每值使用随机 nonce + 基于 HMAC-SHA256 的密钥流异或，并对密文做 HMAC 防篡改；
- 密钥取自环境变量 ``ZHIYUN_SECRET_KEY``；未设置时使用内置演示密钥
  （仅适用于内网演示，生产应注入随机密钥或替换为 KMS / AES-GCM 方案）。
"""
import base64
import hashlib
import hmac
import os

ENC_PREFIX = "enc:v1:"
_NONCE_LEN = 16


def _key() -> bytes:
    secret = os.environ.get("ZHIYUN_SECRET_KEY", "zhiyun-demo-secret-key-change-me")
    return hashlib.sha256(secret.encode("utf-8")).digest()


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hashlib.sha256(key + nonce + counter.to_bytes(8, "big")).digest())
        counter += 1
    return bytes(out[:length])


def is_encrypted(stored: str) -> bool:
    return bool(stored) and stored.startswith(ENC_PREFIX)


def encrypt(plaintext: str) -> str:
    raw = plaintext.encode("utf-8")
    key = _key()
    nonce = os.urandom(_NONCE_LEN)
    ct = bytes(a ^ b for a, b in zip(raw, _keystream(key, nonce, len(raw))))
    payload = nonce + ct
    tag = hmac.new(key, b"v1" + payload, hashlib.sha256).digest()[:16]
    return ENC_PREFIX + base64.urlsafe_b64encode(payload).decode() + "." + base64.urlsafe_b64encode(tag).decode()


def decrypt(stored: str) -> str:
    if not is_encrypted(stored):
        return stored  # 兼容历史明文
    try:
        payload_b64, tag_b64 = stored[len(ENC_PREFIX):].split(".", 1)
        payload = base64.urlsafe_b64decode(payload_b64)
        tag = base64.urlsafe_b64decode(tag_b64)
        key = _key()
        expect = hmac.new(key, b"v1" + payload, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(tag, expect):
            raise ValueError("密文校验失败（HMAC 不匹配，可能被篡改或密钥已更换）")
        nonce, ct = payload[:_NONCE_LEN], payload[_NONCE_LEN:]
        raw = bytes(a ^ b for a, b in zip(ct, _keystream(key, nonce, len(ct))))
        return raw.decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"密文无法解密：{exc}") from exc
