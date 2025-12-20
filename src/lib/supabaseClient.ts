// lib/supabaseClient.ts
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export const supabaseEnvReady = Boolean(supabaseUrl && supabaseAnonKey)
export const supabase = supabaseEnvReady
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null
