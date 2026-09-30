import { z } from "@hono/zod-openapi";

// === LISTA (GET /v1/musics) — paridade com /json_db/pt_musics ===

const AlbumPivotSchema = z.object({
  id_music: z.number(),
  id_album: z.number(),
  track: z.number().nullable(),
});

const AlbumInMusicSchema = z.object({
  id_album: z.number(),
  name: z.string(),
  order: z.number().nullable(),
  type: z.string().nullable(),
  pivot: AlbumPivotSchema,
});

export const MusicListItemSchema = z.object({
  id_music: z.number().openapi({ example: 1 }),
  name: z.string().openapi({ example: "Nosso Sol é Jesus" }),
  has_instrumental_music: z
    .union([z.literal(0), z.literal(1)])
    .openapi({ example: 0 }),
  duration: z.string().nullable().openapi({ example: "00:02:17" }),
  lyric: z
    .string()
    .nullable()
    .openapi({ example: "O nosso sol veio iluminar..." }),
  albums_names: z.string().nullable().openapi({ example: "Nosso Sol é Jesus" }),
  albums: z.array(AlbumInMusicSchema),
});

export const MusicsListResponseSchema = z.object({
  data: z.array(MusicListItemSchema),
  meta: z.object({
    total: z.number().openapi({ example: 1889 }),
    per_page: z.number().openapi({ example: 50 }),
    current_page: z.number().openapi({ example: 1 }),
    last_page: z.number().openapi({ example: 38 }),
  }),
});

// === DETALHE (GET /v1/musics/:id) — paridade com /json_db/music_{id} ===

const LyricDetailSchema = z.object({
  id_lyric: z.number().openapi({ example: 1710 }),
  id_music: z.number().openapi({ example: 1 }),
  lyric: z.string().openapi({ example: "O nosso sol\r\nVeio iluminar" }),
  aux_lyric: z.string().nullable().openapi({ example: null }),
  url_image: z
    .string()
    .nullable()
    .openapi({ example: "/images/hasd_132B.jpg" }),
  image_position: z
    .union([z.string(), z.number()])
    .nullable()
    .openapi({ example: null }),
  time: z.string().nullable().openapi({ example: "00:00:08" }),
  instrumental_time: z.string().nullable().openapi({ example: "00:00:08" }),
  show_slide: z.union([z.literal(0), z.literal(1)]).openapi({ example: 1 }),
  order: z.number().openapi({ example: 1 }),
});

export const MusicDetailSchema = z.object({
  id_music: z.number().openapi({ example: 1 }),
  name: z.string().openapi({ example: "Nosso Sol é Jesus" }),
  duration: z.string().nullable().openapi({ example: "00:02:17" }),
  instrumental_duration: z.string().nullable().openapi({ example: null }),
  url_image: z
    .string()
    .nullable()
    .openapi({ example: "/images/hasd_132B.jpg" }),
  image_position: z
    .union([z.string(), z.number()])
    .nullable()
    .openapi({ example: null }),
  url_music: z.string().nullable().openapi({
    example: "/musics/pt/1992 - Brilha Jesus/Nosso Sol É Jesus.mp3",
  }),
  url_instrumental_music: z.string().nullable().openapi({ example: null }),
  lyric: z.array(LyricDetailSchema),
  albums: z.array(
    z.object({
      id_album: z.number(),
      name: z.string(),
      track: z.number().nullable(),
      url_image: z.string().nullable(),
      order: z.number().nullable(),
    }),
  ),
});
