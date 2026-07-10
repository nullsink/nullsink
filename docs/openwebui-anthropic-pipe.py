"""
title: Anthropic Manifold Pipe (nullsink)
authors: justinh-rahb and christian-taillon (nullsink fork)
author_url: https://github.com/justinh-rahb
funding_url: https://github.com/open-webui
version: 0.3.1-nullsink
license: MIT
description: Claude models through the nullsink proxy. Set the NULLSINK_API_KEY valve (or env var) to your 0sink_ key.
"""

import os
import re
import requests
import json
import time
from typing import List, Union, Generator, Iterator
from pydantic import BaseModel, Field
from open_webui.utils.misc import pop_system_message

# Snapshot date suffix on a model id: "claude-haiku-4-5-20251001" ends in one.
DATE_SUFFIX = re.compile(r"-\d{8}$")


class Pipe:
    class Valves(BaseModel):
        NULLSINK_API_KEY: str = Field(
            default="",
            description="Your nullsink key (0sink_…).",
        )
        NULLSINK_BASE_URL: str = Field(
            default="https://nullsink.is/v1",
            description="Base URL of the Anthropic-format API (no trailing slash).",
        )

    def __init__(self):
        self.type = "manifold"
        self.id = "anthropic"
        self.name = "anthropic/"
        # Only pass the env var when set, so it can't clobber a valve saved in the
        # Open WebUI database (applied after init) or a default edited into Valves.
        env_key = os.getenv("NULLSINK_API_KEY", "")
        self.valves = self.Valves(**({"NULLSINK_API_KEY": env_key} if env_key else {}))
        self.MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB per image

        # Model list cache
        self._models_cache: List[dict] = []
        self._models_cache_ts: float = 0.0
        self._models_cache_ttl_s: int = 300  # refresh every 5 minutes

    def _anthropic_headers(self) -> dict:
        return {
            "x-api-key": self.valves.NULLSINK_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

    # Raise (never return) errors: Open WebUI wraps a raised exception as
    # {"error": {"detail": ...}} and renders its error component. A returned string
    # would render as ordinary chat text.
    def _http_error(self, response) -> Exception:
        try:
            msg = response.json()["error"]["message"]
        except Exception:
            msg = response.text or response.reason
        return Exception(f"HTTP {response.status_code}: {msg}")

    def _fetch_models(self) -> List[dict]:
        """
        Fetch served models from nullsink's /v1/models with a 5-minute cache.
        """
        now = time.time()
        if (
            self._models_cache
            and (now - self._models_cache_ts) < self._models_cache_ttl_s
        ):
            return self._models_cache

        r = requests.get(
            f"{self.valves.NULLSINK_BASE_URL}/models",
            headers=self._anthropic_headers(),
            timeout=(3.05, 30),
        )
        if r.status_code != 200:
            raise self._http_error(r)

        data = r.json()
        raw_models = data.get("data", data if isinstance(data, list) else [])

        def _make_name(model_id: str) -> str:
            # Strip snapshot date suffix: "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
            name = DATE_SUFFIX.sub("", model_id)
            # Restore dotted version: "claude-sonnet-4-6" -> "claude-sonnet-4.6"
            # Only treat trailing short numeric segments as version parts (not dates)
            parts = name.split("-")
            version_start = len(parts)
            for i in range(len(parts) - 1, -1, -1):
                if parts[i].isdigit() and len(parts[i]) <= 2:
                    version_start = i
                else:
                    break
            if version_start < len(parts):
                base = "-".join(parts[:version_start])
                version = ".".join(parts[version_start:])
                return f"{base}-{version}" if base else version
            return name

        # nullsink's catalog lists every active provider's models; keep Anthropic's.
        anthropic_ids = {
            m["id"]
            for m in raw_models
            if m.get("id") and m.get("owned_by", "anthropic") == "anthropic"
        }

        # Drop a dated snapshot (…-20250805) when its undated alias is also listed —
        # nullsink prices/routes them identically, so both would show as duplicates.
        def _redundant_snapshot(model_id: str) -> bool:
            alias = DATE_SUFFIX.sub("", model_id)
            return alias != model_id and alias in anthropic_ids

        models = [
            {"id": mid, "name": _make_name(mid)}
            for mid in anthropic_ids
            if not _redundant_snapshot(mid)
        ]
        models.sort(key=lambda x: x["id"])

        self._models_cache = models
        self._models_cache_ts = now
        return models

    def pipes(self) -> List[dict]:
        try:
            return self._fetch_models()
        except Exception as e:
            print(f"Failed to fetch models: {e}")
            return []

    def process_image(self, image_data):
        """Process image data with size validation."""
        if image_data["image_url"]["url"].startswith("data:image"):
            mime_type, base64_data = image_data["image_url"]["url"].split(",", 1)
            media_type = mime_type.split(":")[1].split(";")[0]

            image_size = len(base64_data) * 3 / 4
            if image_size > self.MAX_IMAGE_SIZE:
                raise ValueError(
                    f"Image size exceeds 5MB limit: {image_size / (1024 * 1024):.2f}MB"
                )
            return {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": base64_data,
                },
            }
        else:
            url = image_data["image_url"]["url"]
            response = requests.head(url, allow_redirects=True, timeout=(3.05, 30))
            content_length = int(response.headers.get("content-length", 0))
            if content_length > self.MAX_IMAGE_SIZE:
                raise ValueError(
                    f"Image at URL exceeds 5MB limit: {content_length / (1024 * 1024):.2f}MB"
                )
            return {"type": "image", "source": {"type": "url", "url": url}}

    def pipe(self, body: dict) -> Union[str, Generator, Iterator]:
        system_message, messages = pop_system_message(body["messages"])

        processed_messages = []
        total_image_size = 0

        for message in messages:
            processed_content = []
            if isinstance(message.get("content"), list):
                for item in message["content"]:
                    if item["type"] == "text":
                        processed_content.append({"type": "text", "text": item["text"]})
                    elif item["type"] == "image_url":
                        processed_image = self.process_image(item)
                        processed_content.append(processed_image)
                        if processed_image["source"]["type"] == "base64":
                            total_image_size += (
                                len(processed_image["source"]["data"]) * 3 / 4
                            )
                            if total_image_size > 100 * 1024 * 1024:
                                raise ValueError(
                                    "Total size of images exceeds 100 MB limit"
                                )
            else:
                processed_content = [
                    {"type": "text", "text": message.get("content", "")}
                ]

            processed_messages.append(
                {"role": message["role"], "content": processed_content}
            )

        # Claude 4.x+ models reject requests with both temperature and top_p/top_k set.
        # Priority: temperature > top_p/top_k > default temperature.
        temperature = body.get("temperature")
        top_p = body.get("top_p")
        top_k = body.get("top_k")

        if temperature is not None:
            sampling_params = {"temperature": temperature}
        elif top_p is not None or top_k is not None:
            sampling_params = {}
            if top_p is not None:
                sampling_params["top_p"] = top_p
            if top_k is not None:
                sampling_params["top_k"] = top_k
        else:
            sampling_params = {"temperature": 0.8}

        payload = {
            "model": body["model"][body["model"].find(".") + 1 :],
            "messages": processed_messages,
            "max_tokens": body.get("max_tokens", 4096),
            **sampling_params,
            "stop_sequences": body.get("stop", []),
            **({"system": str(system_message)} if system_message else {}),
            "stream": body.get("stream", False),
        }

        if body.get("stream", False):
            return self.stream_response(self._anthropic_headers(), payload)
        else:
            return self.non_stream_response(self._anthropic_headers(), payload)

    def stream_response(self, headers, payload):
        url = f"{self.valves.NULLSINK_BASE_URL}/messages"
        with requests.post(
            url, headers=headers, json=payload, stream=True, timeout=(3.05, 60)
        ) as response:
            if response.status_code != 200:
                raise self._http_error(response)

            for line in response.iter_lines():
                if not line:
                    continue
                line = line.decode("utf-8")
                if not line.startswith("data: "):
                    continue
                try:
                    data = json.loads(line[6:])
                    if data["type"] == "content_block_start":
                        yield data["content_block"].get("text", "")
                    elif data["type"] == "content_block_delta":
                        yield data["delta"].get("text", "")
                    elif data["type"] == "message_stop":
                        break
                    elif data["type"] == "message":
                        for content in data.get("content", []):
                            if content["type"] == "text":
                                yield content["text"]
                    time.sleep(0.01)
                except json.JSONDecodeError:
                    print(f"Failed to parse JSON: {line}")
                except KeyError as e:
                    print(f"Unexpected data structure: {e} | data: {data}")

    def non_stream_response(self, headers, payload):
        url = f"{self.valves.NULLSINK_BASE_URL}/messages"
        response = requests.post(url, headers=headers, json=payload, timeout=(3.05, 60))
        if response.status_code != 200:
            raise self._http_error(response)
        res = response.json()
        return res["content"][0]["text"] if res.get("content") else ""
