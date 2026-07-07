-- Supabase SQL migration for Playlist app
-- Run this in your Supabase project's SQL Editor

-- 1. Profiles table (extends auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text default '',
  bio text default '',
  avatar_url text default '',
  banner_url text default '',
  hearts integer default 0,
  hearted_by jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by everyone"
  on public.profiles for select using (true);

create policy "Users can insert their own profile"
  on public.profiles for insert with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update using (auth.uid() = id);

create policy "Authenticated users can heart any profile"
  on public.profiles for update using (auth.role() = 'authenticated');

-- 2. Songs table
create table if not exists public.songs (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  artist text not null,
  url text default '',
  logo text default '',
  lyrics text default '',
  is_local boolean default false,
  file_path text default '',
  created_at timestamptz default now()
);

alter table public.songs enable row level security;

create policy "Users can read their own songs"
  on public.songs for select using (auth.uid() = user_id);

create policy "Users can insert their own songs"
  on public.songs for insert with check (auth.uid() = user_id);

create policy "Users can update their own songs"
  on public.songs for update using (auth.uid() = user_id);

create policy "Users can delete their own songs"
  on public.songs for delete using (auth.uid() = user_id);

-- 3. Playlists table
create table if not exists public.playlists (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  logo text default '',
  song_ids jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

alter table public.playlists enable row level security;

create policy "Users can read their own playlists"
  on public.playlists for select using (auth.uid() = user_id);

create policy "Users can insert their own playlists"
  on public.playlists for insert with check (auth.uid() = user_id);

create policy "Users can update their own playlists"
  on public.playlists for update using (auth.uid() = user_id);

create policy "Users can delete their own playlists"
  on public.playlists for delete using (auth.uid() = user_id);

-- Add deleted column to existing shared_playlists table (run if upgrading)
-- alter table public.shared_playlists add column if not exists deleted boolean default false;

-- 4. Shared_playlists table
create table if not exists public.shared_playlists (
  id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  title text not null,
  author text not null,
  shared_by text default '',
  genre text default '',
  genre_custom text default '',
  duration text default '',
  duration_custom text default '',
  logo text default '',
  songs jsonb not null default '[]'::jsonb,
  likes integer default 0,
  dislikes integer default 0,
  liked_by jsonb default '[]'::jsonb,
  disliked_by jsonb default '[]'::jsonb,
  comments jsonb default '[]'::jsonb,
  deleted boolean default false,
  created_at timestamptz default now()
);

alter table public.shared_playlists enable row level security;

create policy "Shared playlists are viewable by everyone"
  on public.shared_playlists for select using (true);

create policy "Anyone can insert shared playlists"
  on public.shared_playlists for insert with check (true);

create policy "Anyone can update shared playlists"
  on public.shared_playlists for update using (true);

create policy "Anyone can delete shared playlists"
  on public.shared_playlists for delete using (true);

create policy "Users can update their own shared playlists"
  on public.shared_playlists for update using (auth.uid() = user_id);

create policy "Users can delete their own shared playlists"
  on public.shared_playlists for delete using (auth.uid() = user_id);

-- 5. Create storage bucket for audio files
insert into storage.buckets (id, name, public) values ('audio', 'audio', true)
on conflict (id) do nothing;

create policy "Audio files are publicly readable"
  on storage.objects for select using (bucket_id = 'audio');

create policy "Authenticated users can upload audio files"
  on storage.objects for insert with check (bucket_id = 'audio' and auth.role() = 'authenticated');

create policy "Users can delete their own audio files"
  on storage.objects for delete using (bucket_id = 'audio' and auth.uid() = owner);

create policy "Anyone can upload shared audio files"
  on storage.objects for insert with check (bucket_id = 'audio' and name like 'shared/%');

-- 6. Create profiles automatically on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data->>'username');
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
