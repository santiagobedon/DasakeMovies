import { Request, Response } from "express";
import axios from "axios";
import dotenv from "dotenv";
import { supabase } from "../config/database";

dotenv.config();

const API_KEY = process.env.PEXELS_API_KEY;
if (!API_KEY) throw new Error("falta la clave de api de pexels en el archivo .env");

/**
 * Default video categories used for fetching movies.
 * constant
 * type {string[]}
 */
const categories = ["accion", "naturaleza", "deportes", "cine", "musica", "tecnologia"];

/**
 * In-memory cache for fetched movies.
 * type {any[] | null}
 */
let cachedMovies: any[] | null = null;

/**
 * Timestamp of the last cache update.
 * type {number}
 */
let lastFetchTime = 0;

/**
 * Cache validity duration in milliseconds (1 hour).
 * constant
 * type {number}
 */
const CACHE_DURATION = 60 * 60 * 1000;

/**
 * List of trusted video domains allowed in the results.
 * constant
 * type {string[]}
 */
const ALLOWED_DOMAINS = ["pexels.com", "videos.pexels.com", "player.vimeo.com"];

/**
 * Fetches videos from the Pexels API by category and caches them securely.
 *
 * Uses a one-hour cache to reduce redundant API calls.
 * Filters video files to ensure they come from trusted domains and have valid HTTPS URLs.
 *
 * async
 * function getMovies
 * param {Request} req - Express request object.
 * param {Response} res - Express response object.
 * returns {Promise<void>} JSON response with cached or freshly fetched videos.
 */
export const getMovies = async (req: Request, res: Response) => {
  try {
    const now = Date.now();

    if (cachedMovies && now - lastFetchTime < CACHE_DURATION) {
      console.log("🟢 devolviendo peliculas desde cache segura");
      return res.json(cachedMovies);
    }

    console.log("🟡 actualizando cache de peliculas seguras...");
    const allMovies: any[] = [];

    for (const cat of categories) {
      const response = await axios.get("https://api.pexels.com/videos/search", {
        headers: { Authorization: API_KEY },
        params: { query: cat, per_page: 6 },
      });

      const videos = response.data.videos
        .map((v: any) => {
          const safeFiles = (v.video_files || []).filter((f: any) => {
            if (!f.file_type?.startsWith("video/")) return false;
            if (!f.link?.startsWith("https://")) return false;

            try {
              const urlDomain = new URL(f.link).hostname;
              return ALLOWED_DOMAINS.some((domain) => urlDomain.endsWith(domain));
            } catch {
              return false;
            }
          });

          // si no hay archivos seguros, no incluir el video
          if (!safeFiles.length) return null;

          return {
            id: v.id,
            url: v.url,
            image: v.image ?? v.video_pictures?.[0]?.picture ?? "",
            category: cat,
            user: {
              name: v.user?.name ?? "autor desconocido",
              url: v.user?.url ?? "",
            },
            video_files: safeFiles,
          };
        })
        .filter(Boolean); // elimina los null

      allMovies.push(...videos);
    }

    cachedMovies = allMovies;
    lastFetchTime = now;
    console.log("✅ peliculas seguras guardadas en cache");
    res.json(allMovies);
  } catch (err: any) {
    console.error("❌ error al obtener videos:", err.message);
    res.status(500).json({ error: "no se pudieron cargar los videos" });
  }
};

/**
 * Adds a video to the user's list of favorites in the database.
 *
 * async
 * function addFavorite
 * param {Request} req - Express request object containing `userId`, `videoId`, `videoUrl`, and optional `videoImage`.
 * param {Response} res - Express response object.
 * returns {Promise<void>} JSON message confirming success or error.
 */
export const addFavorite = async (req: Request, res: Response) => {
  const { userId, videoId, videoUrl, videoImage } = req.body;

  if (!userId || !videoId || !videoUrl)
    return res.status(400).json({ message: "faltan datos obligatorios" });

  const { data, error } = await supabase
    .from("favorites")
    .insert([{ user_id: userId, video_id: videoId, video_url: videoUrl, video_image: videoImage }]);

  if (error) return res.status(500).json({ message: "error al agregar favorito", error });

  res.status(201).json({ message: "favorito agregado correctamente", data });
};

/**
 * Removes a video from the user's list of favorites in the database.
 *
 * async
 * function removeFavorite
 * param {Request} req - Express request object containing `userId` and `videoId`.
 * param {Response} res - Express response object.
 * returns {Promise<void>} JSON message confirming success or error.
 */
export const removeFavorite = async (req: Request, res: Response) => {
  const { userId, videoId } = req.body;

  if (!userId || !videoId)
    return res.status(400).json({ message: "faltan datos obligatorios" });

  const { error } = await supabase
    .from("favorites")
    .delete()
    .eq("user_id", userId)
    .eq("video_id", videoId);

  if (error) return res.status(500).json({ message: "error al eliminar favorito", error });

  res.status(200).json({ message: "favorito eliminado correctamente" });
};

/**
 * Retrieves all favorite videos of a specific user.
 *
 * async
 * function getFavorites
 * param {Request} req - Express request object containing `userId` as a query parameter.
 * param {Response} res - Express response object.
 * returns {Promise<void>} JSON array of the user's favorite videos.
 */
export const getFavorites = async (req: Request, res: Response) => {
  const userId = req.query.userId as string;

  if (!userId) return res.status(400).json({ message: "falta userId" });

  const { data, error } = await supabase
    .from("favorites")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ message: "error al obtener favoritos", error });

  res.status(200).json(data);
};
/**
 * ===============================
 * COMENTARIOS DE USUARIOS
 * ===============================
 */

/**
 * crea un comentario nuevo en una pelicula
 */
export const addComment = async (req: Request, res: Response) => {
  const { userId, movieExternalId, content, title, posterUrl } = req.body;

  if (!userId || !movieExternalId || !content)
    return res.status(400).json({ message: "faltan datos obligatorios" });

  try {
    // verificar si la pelicula ya existe
    let { data: existingMovie, error: movieError } = await supabase
      .from("movies")
      .select("id")
      .eq("external_id", movieExternalId.toString())
      .maybeSingle();

    // crear si no existe
    if (!existingMovie) {
      const { data: newMovie, error: createError } = await supabase
        .from("movies")
        .insert([{ external_id: movieExternalId.toString(), title, poster_url: posterUrl }])
        .select("id")
        .single();

      if (createError) throw createError;
      existingMovie = newMovie;
    }

    // crear comentario
    const { data, error } = await supabase
      .from("comments")
      .insert([{ user_id: userId, movie_id: existingMovie.id, content }])
      .select();

    if (error) throw error;

    res.status(201).json({ message: "comentario agregado correctamente", data });
  } catch (err: any) {
    res.status(500).json({ message: "error al agregar comentario", error: err.message });
  }
};

/**
 * obtiene todos los comentarios de una pelicula
 */
export const getCommentsByMovie = async (req: Request, res: Response) => {
  const movieExternalId = req.params.movieExternalId;

  if (!movieExternalId)
    return res.status(400).json({ message: "falta el id externo de la pelicula" });

  try {
    // obtener id interno de la pelicula
    const { data: movie } = await supabase
      .from("movies")
      .select("id")
      .eq("external_id", movieExternalId.toString())
      .maybeSingle();

    if (!movie) return res.status(200).json([]); // sin error si no hay comentarios

    // obtener comentarios con info del usuario
    const { data, error } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        created_at,
        updated_at,
        user_id,
        users!inner(firstName)
      `)
      .eq("movie_id", movie.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const formatted = (data || []).map((c: any) => ({
      id: c.id,
      user: c.users?.firstName ?? "usuario",
      userId: c.user_id,
      text: c.content,
    }));

    res.status(200).json(formatted);
  } catch (err: any) {
    res.status(500).json({ message: "error al obtener comentarios", error: err.message });
  }
};

/**
 * actualiza un comentario existente
 */
export const updateComment = async (req: Request, res: Response) => {
  const { commentId } = req.params;
  const { userId, content } = req.body;

  if (!commentId || !userId || !content)
    return res.status(400).json({ message: "faltan datos obligatorios" });

  try {
    const { data: users, error } = await supabase
      .from("comments")
      .update({ content })
      .eq("id", commentId)
      .eq("user_id", userId)
      .select("id, user_id, content, created_at");

    if (error) throw error;
    if (!users || users.length === 0)
      return res.status(404).json({ message: "usuario no encontrado o no autorizado" });

    res.status(200).json({ message: "comentario actualizado correctamente", comment: users[0] });
  } catch (err: any) {
    res.status(500).json({ message: "error al actualizar comentario", error: err.message });
  }
};

/**
 * elimina un comentario existente
 */
export const deleteComment = async (req: Request, res: Response) => {
  const { commentId } = req.params;
  const { userId } = req.body;

  if (!commentId || !userId)
    return res.status(400).json({ message: "faltan datos obligatorios" });

  try {
    const { error } = await supabase
      .from("comments")
      .delete()
      .eq("id", commentId)
      .eq("user_id", userId);

    if (error) throw error;

    res.status(200).json({ message: "comentario eliminado correctamente" });
  } catch (err: any) {
    res.status(500).json({ message: "error al eliminar comentario", error: err.message });
  }
};


/**
 * ===============================
 * CALIFICACIONES / RATINGS
 * ===============================
 */
export const rateMovie = async (req: Request, res: Response) => {
  const { userId, movieExternalId, rating, title, posterUrl } = req.body;

  if (!userId || !movieExternalId || !rating)
    return res.status(400).json({ message: "faltan datos obligatorios" });

  if (rating < 1 || rating > 5)
    return res.status(400).json({ message: "la calificacion debe estar entre 1 y 5" });

  try {
    // buscar o crear pelicula
    let { data: existingMovie, error: movieError } = await supabase
      .from("movies")
      .select("id")
      .eq("external_id", movieExternalId.toString())
      .maybeSingle();

    if (!existingMovie) {
      const { data: newMovie, error: createError } = await supabase
        .from("movies")
        .insert([{ external_id: movieExternalId.toString(), title, poster_url: posterUrl }])
        .select("id")
        .single();

      if (createError) throw createError;
      existingMovie = newMovie;
    }

    // insertar o actualizar calificacion
    const { error: upsertError } = await supabase
      .from("rankings")
      .upsert(
        [{ user_id: userId, movie_id: existingMovie.id, rating }],
        { onConflict: "user_id, movie_id" }
      );

    if (upsertError) throw upsertError;

    res.status(201).json({ message: "calificacion registrada correctamente" });
  } catch (err: any) {
    res.status(500).json({ message: "error al registrar calificacion", error: err.message });
  }
};

/**
 * obtiene la calificacion promedio y del usuario actual
 */
export const getMovieRating = async (req: Request, res: Response) => {
  const movieExternalId = req.params.movieExternalId;
  const userId = req.query.userId as string;

  if (!movieExternalId)
    return res.status(400).json({ message: "falta el id externo de la pelicula" });

  try {
    const { data: movie } = await supabase
      .from("movies")
      .select("id")
      .eq("external_id", movieExternalId.toString())
      .maybeSingle();

    if (!movie) return res.status(200).json({ promedio: 0, userRating: null });

    const { data: allRatings, error } = await supabase
      .from("rankings")
      .select("rating")
      .eq("movie_id", movie.id);

    if (error) throw error;

      const promedio =
        allRatings && allRatings.length > 0
          ? (allRatings as any[]).reduce((acc: number, cur: any) => acc + cur.rating, 0) / allRatings.length
          : 0;

    let userRating: number | null = null;
    if (userId) {
      const { data: userData } = await supabase
        .from("rankings")
        .select("rating")
        .eq("movie_id", movie.id)
        .eq("user_id", userId)
        .maybeSingle();

      if (userData) userRating = userData.rating;
    }

    res.status(200).json({ promedio, userRating });
  } catch (err: any) {
    res.status(500).json({ message: "error al obtener promedio", error: err.message });
  }
};
