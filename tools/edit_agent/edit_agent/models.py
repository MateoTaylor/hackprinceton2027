"""Chat models by role. Swapping the model behind a role is a change to config.py, not to the graph."""
from langchain.chat_models import init_chat_model


def chat_model(role, base_url=None, max_tokens=900):
    if role.provider == "local":
        if not base_url:
            raise ValueError("a local role needs the URL of the running llama.cpp server")
        return init_chat_model(role.model, model_provider="openai", base_url=base_url.rstrip("/") + "/v1",
                               api_key="local", temperature=0, seed=0, max_tokens=max_tokens,
                               timeout=600, max_retries=0, use_responses_api=False)
    if role.provider == "anthropic":                # text only; reads ANTHROPIC_API_KEY from the environment
        return init_chat_model(role.model, model_provider="anthropic", max_tokens=max_tokens, timeout=600)
    raise ValueError(f"unknown provider {role.provider!r}")
