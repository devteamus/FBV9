/**
 * Facebook Graph API client — TypeScript port of v1's FacebookPoster.
 *
 * Every method preserves the exact v1 flow:
 *  - Image: unpublished upload → feed post with attached_media
 *  - Video: direct upload to /videos with published=true (long timeout)
 *  - Reel: 3-phase (start → binary rupload → finish)
 *  - Text: POST /feed with message
 *  - Comment: POST /{object_id}/comments (separate, failure never fails parent)
 */

export class FacebookAPIError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`Graph API ${code}: ${message}`);
    this.name = "FacebookAPIError";
    this.code = code;
  }
}

export interface FbPostResult {
  id: string;
}

export class FacebookPoster {
  private accessToken: string;
  private pageId: string;
  private baseUrl: string;

  constructor(
    accessToken: string,
    pageId: string,
    apiVersion: string = "v20.0"
  ) {
    this.accessToken = accessToken;
    this.pageId = pageId;
    this.baseUrl = `https://graph.facebook.com/${apiVersion}`;
  }

  /**
   * Low-level request helper.  Mirrors v1's _request exactly.
   */
  private async request<T = Record<string, unknown>>(
    method: "GET" | "POST",
    endpoint: string,
    options?: {
      data?: Record<string, string>;
      params?: Record<string, string>;
      timeout?: number;
      headers?: Record<string, string>;
      body?: Uint8Array; // for raw binary uploads (reel rupload) — Buffer is a Uint8Array
    }
  ): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const defaultTimeout = method === "GET" ? 30_000 : 120_000;
    const timeout = options?.timeout ?? defaultTimeout;

    try {
      let resp: Response;

      if (method === "GET") {
        const searchParams = new URLSearchParams({
          access_token: this.accessToken,
          ...options?.params,
        });
        resp = await fetch(`${url}?${searchParams}`, {
          signal: AbortSignal.timeout(timeout),
        });
      } else {
        // For reel rupload we need raw body + custom headers
        if (options?.body) {
          resp = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `OAuth ${this.accessToken}`,
              "Content-Type": "application/octet-stream",
              ...options.headers,
            },
            body: options.body as BodyInit,
            signal: AbortSignal.timeout(timeout),
          });
        } else {
          // Normal form-encoded POST
          const formData = new URLSearchParams({
            access_token: this.accessToken,
            ...(options?.data ?? {}),
          });
          resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formData.toString(),
            signal: AbortSignal.timeout(timeout),
          });
        }
      }

      if (!resp.ok) {
        let errBody: Record<string, unknown> = {};
        try {
          errBody = (await resp.json()) as Record<string, unknown>;
        } catch {
          // non-JSON error body
        }
        const fbError = errBody.error as Record<string, unknown> | undefined;
        const code = String(fbError?.code ?? "unknown");
        const message = String(
          fbError?.message ?? `HTTP ${resp.status}`
        );
        throw new FacebookAPIError(code, message);
      }

      return (await resp.json()) as T;
    } catch (err) {
      if (err instanceof FacebookAPIError) throw err;
      throw new FacebookAPIError(
        "network_error",
        `Network error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Validate the token by fetching the page info (incl. profile picture).
   * The picture URL is a public CDN link — persisted by the caller on the
   * Account row so the dashboard can render avatars without any
   * Graph API call from the web process (§10).
   */
  async validate(): Promise<{ id: string; name: string; picture?: string }> {
    const result = await this.request<{
      id: string;
      name: string;
      picture?: { data?: { url?: string; is_silhouette?: boolean } };
    }>("GET", this.pageId, {
      params: { fields: "id,name,picture.type(large)" },
    });
    const pictureUrl = result.picture?.data?.url ?? undefined;
    return { id: result.id, name: result.name, picture: pictureUrl };
  }

  /**
   * List comments on a post (newest first). Used by the worker to verify
   * whether a comment whose publish outcome is uncertain actually made it
   * to Facebook — prevents duplicate comments on retry.
   *
   * Requires the page token to have read access (pages_read_engagement /
   * pages_manage_engagement). If the permission is missing the Graph API
   * returns an error, which callers treat as "verification unavailable".
   */
  async listComments(
    objectId: string,
    limit = 50
  ): Promise<Array<{ id: string; message?: string; from?: { id: string; name?: string } }>> {
    const result = await this.request<{
      data: Array<{ id: string; message?: string; from?: { id: string; name?: string } }>;
    }>("GET", `${objectId}/comments`, {
      params: { fields: "id,message,from{id,name}", limit: String(limit), order: "reverse_chronological" },
    });
    return result.data ?? [];
  }

  /**
   * Image post — two-step flow (same as v1):
   * 1. Upload photo unpublished to /{page}/photos (published=false)
   * 2. Create timeline story via /{page}/feed with attached_media
   *
   * Posting straight to /photos with published=true doesn't reliably
   * create a timeline story.
   */
  async postImage(caption: string, imageUrl: string): Promise<FbPostResult> {
    // Step 1: upload unpublished
    const uploaded = await this.request<{ id: string }>(
      "POST",
      `${this.pageId}/photos`,
      {
        data: {
          url: imageUrl,
          published: "false",
        },
      }
    );
    const photoId = uploaded.id;
    if (!photoId) {
      throw new FacebookAPIError("upload_error", "Photo upload did not return an id");
    }

    // Step 2: create feed story with attached photo
    const result = await this.request<FbPostResult>(
      "POST",
      `${this.pageId}/feed`,
      {
        data: {
          message: caption,
          'attached_media[0]': JSON.stringify({ media_fbid: photoId }),
          published: "true",
        },
      }
    );
    return result;
  }

  /**
   * Video post — direct upload to /{page}/videos.
   * Facebook fetches file_url synchronously — can take several minutes.
   * Long timeout (~8 min) is expected behavior, not a bug.
   */
  async postVideo(caption: string, videoUrl: string): Promise<FbPostResult> {
    const VIDEO_TIMEOUT = parseInt(
      process.env.VIDEO_UPLOAD_TIMEOUT_MS || "480000",
      10
    );
    const result = await this.request<FbPostResult>(
      "POST",
      `${this.pageId}/videos`,
      {
        data: {
          file_url: videoUrl,
          description: caption,
          published: "true",
        },
        timeout: VIDEO_TIMEOUT,
      }
    );
    return result;
  }

  /**
   * Reel post — 3-phase flow (same as v1):
   * 1. POST /{page}/video_reels with upload_phase=start → video_id + upload_url
   * 2. Download video, POST raw binary to upload_url (rupload)
   *    - Stream instead of buffering entire file in memory (v1 buffered)
   * 3. POST /{page}/video_reels with upload_phase=finish, video_state=PUBLISHED
   */
  async postReel(caption: string, videoUrl: string): Promise<FbPostResult> {
    const VIDEO_TIMEOUT = parseInt(
      process.env.VIDEO_UPLOAD_TIMEOUT_MS || "480000",
      10
    );

    // Phase 1: start upload session
    const start = await this.request<{ video_id: string; upload_url: string }>(
      "POST",
      `${this.pageId}/video_reels`,
      { data: { upload_phase: "start" } }
    );
    const videoId = start.video_id;
    const uploadUrl = start.upload_url;
    if (!videoId || !uploadUrl) {
      throw new FacebookAPIError(
        "reel_start_error",
        "Could not start Reels upload session"
      );
    }

    try {
      // Phase 2a: Download the video
      console.log(`[reel] ${videoId}: downloading from ${videoUrl}`);
      const videoResp = await fetch(videoUrl, {
        signal: AbortSignal.timeout(300_000),
      });
      if (!videoResp.ok) {
        throw new Error(`Download failed: HTTP ${videoResp.status}`);
      }
      if (!videoResp.body) {
        throw new Error("Download failed: no response body (streaming unsupported)");
      }

      // Phase 2b: Stream binary to rupload endpoint
      // Stream instead of buffering the whole file (§10: no buffering entire videos)
      const fileSizeStr = videoResp.headers.get("content-length");
      const contentLength = fileSizeStr ? parseInt(fileSizeStr, 10) : 0;

      console.log(`[reel] ${videoId}: streaming to rupload (size: ${contentLength})…`);
      const uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `OAuth ${this.accessToken}`,
          "Content-Type": "application/octet-stream",
          offset: "0",
          file_size: String(contentLength),
          ...(contentLength > 0 ? { "Content-Length": String(contentLength) } : {}),
        },
        body: videoResp.body,
        // `duplex` is required by undici/Node fetch for streaming request
        // bodies but isn't in lib.dom's RequestInit type yet.
        duplex: "half",
        signal: AbortSignal.timeout(VIDEO_TIMEOUT),
      } as RequestInit & { duplex: "half" });

      if (!uploadResp.ok) {
        const text = await uploadResp.text().catch(() => "");
        throw new Error(`rupload failed: HTTP ${uploadResp.status} ${text}`);
      }
      console.log(`[reel] ${videoId}: rupload complete, finishing…`);
    } catch (err) {
      if (err instanceof FacebookAPIError) throw err;
      throw new FacebookAPIError(
        "reel_upload_error",
        `Reel upload failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Phase 3: finish and publish
    const finish = await this.request<Record<string, unknown>>(
      "POST",
      `${this.pageId}/video_reels`,
      {
        data: {
          upload_phase: "finish",
          video_id: videoId,
          video_state: "PUBLISHED",
          description: caption,
        },
        timeout: 60_000,
      }
    );
    // Finish doesn't always echo the video_id back — normalize
    const finishedId = typeof finish.id === "string" ? finish.id : videoId;
    return { id: finishedId };
  }

  /**
   * Text post — plain status update, no media.
   */
  async postText(caption: string): Promise<FbPostResult> {
    return this.request<FbPostResult>("POST", `${this.pageId}/feed`, {
      data: { message: caption, published: "true" },
    });
  }

  /**
   * Comment on a published post.
   * Kept separate so failure never marks the parent post as failed.
   */
  async postComment(objectId: string, message: string): Promise<FbPostResult> {
    return this.request<FbPostResult>("POST", `${objectId}/comments`, {
      data: { message },
    });
  }

  /**
   * Delete a published post/photo/video/reel from Facebook.
   * Graph API's DELETE verb is invoked via POST + method override,
   * which is Facebook's own documented pattern for environments
   * where a raw HTTP DELETE isn't convenient.
   */
  async deletePost(objectId: string): Promise<{ success: boolean }> {
    const result = await this.request<{ success: boolean }>(
      "POST",
      objectId,
      { data: { method: "delete" } }
    );
    return result;
  }
}