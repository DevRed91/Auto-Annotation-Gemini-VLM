import dotenv from 'dotenv';
dotenv.config();

export type WorldPrompt = 
    | { type: 'text'; text_prompt: string }
    | { type: 'image'; image_asset_id: string }
    | { type: 'panorama'; image_asset_id: string }
    | { type: 'video'; video_asset_id: string };

export interface GenerationRequest {
    display_name: string;
    model: string;
    world_prompt: WorldPrompt;
}

export interface PrepareUploadResponse {
    media_asset_id: string;
    upload_url: string;
}

export interface OperationResponse {
    operation_id: string;
    done: boolean;
    response?: {
        assets: {
            splats: {
                spz_urls: {
                    full: string;
                    [key: string]: string;
                };
            };
        };
    };
    error?: any;
}

export class WorldLabsService {
    private apiKey: string;
    private baseUrl = 'https://api.worldlabs.ai/marble/v1';

    constructor() {
        this.apiKey = process.env.API_KEY || '';
    }

    async generateWorld(prompt: string): Promise<string> {
        return this.submitGeneration({
            type: 'text',
            text_prompt: prompt
        });
    }

    async generateWorldFromImage(imageAssetId: string): Promise<string> {
        return this.submitGeneration({
            type: 'image',
            image_asset_id: imageAssetId
        });
    }

    private async submitGeneration(worldPrompt: WorldPrompt): Promise<string> {
        const response = await fetch(`${this.baseUrl}/worlds:generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'WLT-Api-Key': this.apiKey
            },
            body: JSON.stringify({
                display_name: `Generated World - ${new Date().toLocaleTimeString()}`,
                model: 'marble-1.1',
                world_prompt: worldPrompt
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Generation failed: ${JSON.stringify(error)}`);
        }

        const data = await response.json();
        const operationId = data.operation_id;

        // Start polling
        return this.pollOperation(operationId);
    }

    async uploadMedia(file: File): Promise<string> {
        // 1. Prepare upload
        const prepareResponse = await fetch(`${this.baseUrl}/media-assets:prepare_upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'WLT-Api-Key': this.apiKey
            },
            body: JSON.stringify({
                file_name: file.name,
                kind: file.type.startsWith('image/') ? 'image' : 'video',
                extension: file.name.split('.').pop()
            })
        });

        if (!prepareResponse.ok) {
            const error = await prepareResponse.json();
            throw new Error(`Prepare upload failed: ${JSON.stringify(error)}`);
        }

        const { media_asset_id, upload_url }: PrepareUploadResponse = await prepareResponse.json();

        // 2. Upload file
        const uploadResponse = await fetch(upload_url, {
            method: 'PUT',
            body: file,
            headers: {
                'Content-Type': file.type
            }
        });

        if (!uploadResponse.ok) {
            throw new Error(`File upload failed: ${uploadResponse.statusText}`);
        }

        return media_asset_id;
    }

    private async pollOperation(operationId: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const interval = setInterval(async () => {
                try {
                    const response = await fetch(`${this.baseUrl}/operations/${operationId}`, {
                        headers: {
                            'WLT-Api-Key': this.apiKey
                        }
                    });

                    if (!response.ok) {
                        clearInterval(interval);
                        reject(new Error('Polling failed'));
                        return;
                    }

                    const data: OperationResponse = await response.json();

                    if (data.done) {
                        clearInterval(interval);
                        if (data.error) {
                            reject(new Error(`Operation finished with error: ${JSON.stringify(data.error)}`));
                        } else if (data.response?.assets?.splats?.spz_urls?.full) {
                            resolve(data.response.assets.splats.spz_urls.full);
                        } else {
                            reject(new Error('Operation complete but no splat URL found'));
                        }
                    }
                } catch (error) {
                    clearInterval(interval);
                    reject(error);
                }
            }, 5000); // Poll every 5 seconds
        });
    }
}
