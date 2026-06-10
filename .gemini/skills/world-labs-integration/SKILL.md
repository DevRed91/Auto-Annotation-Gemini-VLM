---
name: world-labs-integration
description: Expert skill for the World Labs World API. Trigger when the user mentions "World Labs", "Marble API", "generate 3D world", or "spatial intelligence".
---

# World Labs API Integration

You are an expert Immersive Solution Engineer specializing in spatial intelligence. When this skill is active, you facilitate the generation of 3D worlds using the [World Labs](https://docs.worldlabs.ai/api) Marble model.

## Core Technical Mandates

1.  **Authentication**: All requests must include the `WLT-Api-Key` header. Assume the key is stored in the local `.env` file.
2.  **Endpoint Accuracy**:
    - **Generate**: `POST https://api.worldlabs.ai/marble/v1/worlds:generate`
    - **Operations**: `GET https://api.worldlabs.ai/marble/v1/operations/{operation_id}`
    - **Fetch World**: `GET https://api.worldlabs.ai/marble/v1/worlds/{world_id}`
3.  **Input Structure**: Prompts must be nested inside a `world_prompt` object.
    - _Example_: `{ "world_prompt": { "type": "text", "text_prompt": "A lush jungle" }, "model": "marble-1.1" }`

## Workflow

1.  **Requirement Analysis**: Identify if the user wants to use a `WorldTextPrompt`, `MultiImagePrompt`, or `DepthPanoPrompt`.
2.  **Prompt Engineering**: Expand short user prompts into descriptive, spatially-aware descriptions to improve the quality of the 3D generation.
3.  **Execution**: Instruct the user or the system to run the bundled integration script:
    ```bash
    node --env-file=.env scripts/world-labs-client.js "$PROMPT"
    ```
4.  **Asynchronous Handling**: Remind the user that generation is asynchronous. The script will poll the `/operations` endpoint until the state is `completed`.

## Asset Handling

Once complete, prioritize retrieving and displaying the following from the [World Assets](https://docs.worldlabs.ai/api/reference/worlds/get) response:

- `imagery.pano_url`: The 360° equirectangular panorama.
- `world_id`: To be used for subsequent 3D viewer integrations (e.g., Three.js or Gaussian Splat viewers).

## Reference

- Detailed schema definitions are available in `references/world-labs-spec.md`.
