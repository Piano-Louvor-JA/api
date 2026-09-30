import { z } from "zod";

// Custom Collections
export const CustomCollectionSchema = z.object({
  id_collection: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  cover_url: z.string().nullable().optional(),
  owner_id: z.number().nullable().optional(),
  author_name: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  musics_count: z.number().optional(),
});

export const CustomCollectionsListResponseSchema = z.object({
  data: z.array(CustomCollectionSchema),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    per_page: z.number(),
    last_page: z.number(),
  }),
});

export const CreateCustomCollectionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  author_name: z.string().max(80).nullable().optional(),
  visibility: z.enum(["public", "private"]).optional(),
});

export const UpdateCustomCollectionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  cover_url: z.string().nullable().optional(),
  visibility: z.enum(["public", "private"]).optional(),
});

// Custom Musics
export const CustomMusicSchema = z.object({
  id_music: z.number(),
  id_collection: z.number(),
  name: z.string(),
  lyric: z.string().nullable(),
  auxiliary_lyric: z.string().nullable(),
  id_file_audio: z.number().nullable(),
  id_file_instrumental: z.number().nullable(),
  id_file_image: z.number().nullable(),
  duration: z.number().nullable(),
  // Link p/ hino oficial (null = música própria do usuário)
  official_music_id: z.number().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  // Nested
  audio_url: z.string().nullable().optional(),
  instrumental_url: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  image_position: z.number().nullable().optional(),
});

export const CustomMusicsListResponseSchema = z.object({
  data: z.array(CustomMusicSchema),
  meta: z.object({
    total: z.number(),
    per_page: z.number(),
    current_page: z.number(),
    last_page: z.number(),
  }),
});

export const CreateCustomMusicSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    lyric: z.string().optional(),
    auxiliary_lyric: z.string().optional(),
    id_file_audio: z.number().optional(),
    id_file_instrumental: z.number().optional(),
    id_file_image: z.number().optional(),
    duration: z.number().optional(),
    // Hino oficial da API (link): id_music da tabela musics. Quando presente,
    // a faixa é um atalho — playback/letra resolvem pelo catálogo oficial.
    official_music_id: z.number().int().positive().optional(),
  })
  .refine(
    (v) => v.official_music_id != null || (v.name?.trim().length ?? 0) > 0,
    {
      message: "name é obrigatório quando official_music_id não é informado",
      path: ["name"],
    },
  );

export const UpdateCustomMusicSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  lyric: z.string().optional(),
  auxiliary_lyric: z.string().optional(),
  id_file_audio: z.number().optional(),
  id_file_instrumental: z.number().optional(),
  id_file_image: z.number().optional(),
  duration: z.number().optional(),
});

// Custom Lyrics (estrofes)
export const CustomLyricSchema = z.object({
  id_lyric: z.number(),
  id_music: z.number(),
  lyric: z.string(),
  aux_lyric: z.string().nullable(),
  id_file_image: z.number().nullable(),
  time: z.string(),
  instrumental_time: z.string(),
  show_slide: z.number(),
  order: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  // Nested
  image_url: z.string().nullable().optional(),
  image_position: z.number().nullable().optional(),
});

export const CustomLyricsListResponseSchema = z.object({
  data: z.array(CustomLyricSchema),
});

export const CreateCustomLyricSchema = z.object({
  lyric: z.string().min(1),
  aux_lyric: z.string().optional(),
  id_file_image: z.number().optional(),
  time: z.string().optional(),
  instrumental_time: z.string().optional(),
  show_slide: z.number().optional(),
  order: z.number().optional(),
});

export const UpdateCustomLyricSchema = z.object({
  lyric: z.string().min(1).optional(),
  aux_lyric: z.string().optional(),
  id_file_image: z.number().optional(),
  time: z.string().optional(),
  instrumental_time: z.string().optional(),
  show_slide: z.number().optional(),
  order: z.number().optional(),
});

// Import .slja
export const ImportSljaResponseSchema = z.object({
  success: z.boolean(),
  collection_id: z.number().optional(),
  music_id: z.number().optional(),
  message: z.string(),
});

// Export .slja
export const ExportSljaRequestSchema = z.object({
  collection_id: z.number(),
  music_id: z.number().optional(),
});
export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(80),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** Pedido de reset: só o e-mail. Resposta SEMPRE 200 (não revela se o
 * e-mail existe — evita enumeração de contas). */
export const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

/** Efetiva o reset: token (válido, não expirado, 1h) + senha nova. */
export const ResetPasswordSchema = z.object({
  token: z.string().min(16),
  password: z.string().min(8),
});

export const AuthResponseSchema = z.object({
  token: z.string().min(1),
  user: z.object({
    id_user: z.number(),
    email: z.string().email(),
    displayName: z.string(),
  }),
});

export const MeResponseSchema = z.object({
  user: z.object({
    id_user: z.number(),
    email: z.string().email(),
    displayName: z.string(),
  }),
});
