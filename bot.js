const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelType,
  Collection,
  ActivityType,
  AuditLogEvent
} = require('discord.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PREFIX = 'T!';
const ORDU_YONETIMI_ROL_ADI = 'Ordu Yönetimi';
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
const CONFIG_FILE = path.join(__dirname, 'tdr-config.json');

// Render Web Service Port (7/24 ayakta kalması için HTTP sunucusu)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('TRA / TDR Bot Aktif.');
}).listen(PORT, () => {
  console.log(`HTTP sunucusu ${PORT} portunda çalışıyor.`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration
  ]
});

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadBlacklist() {
  return loadJson(BLACKLIST_FILE, []);
}

function saveBlacklist(data) {
  saveJson(BLACKLIST_FILE, data);
}

function loadConfig() {
  return loadJson(CONFIG_FILE, { logChannelId: null });
}

function saveConfig(data) {
  saveJson(CONFIG_FILE, data);
}

// Spam takibi
const spamMap = new Collection();

// Küfür ve reklam filtre listesi
const BAD_WORDS = [
  'amk', 'aq', 'orospu', 'piç', 'pic', 'sikerim', 'sikik', 'yarrak', 'kahpe',
  'göt', 'got', 'ibne', 'şerefsiz', 'serefsiz', 'pezevenk', 'mal', 'salak'
];
const LINK_REGEX = /(https?:\/\/[^\s]+|discord\.gg\/[^\s]+|discordapp\.com\/invite\/[^\s]+)/i;

function hasOrduYonetimi(member) {
  if (!member) return false;
  return member.roles.cache.some(r => r.name.toLowerCase() === ORDU_YONETIMI_ROL_ADI.toLowerCase());
}

// Sohbet kanalını bul
function getChatChannel(guild) {
  return (
    guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && ['sohbet', 'genel', 'chat'].includes(c.name.toLowerCase())
    ) || guild.channels.cache.find(c => c.type === ChannelType.GuildText)
  );
}

// Log kanalını getir
async function getLogChannel(guild, fallbackToCreate = true) {
  const cfg = loadConfig();
  if (cfg.logChannelId) {
    const ch = guild.channels.cache.get(cfg.logChannelId) || await guild.channels.fetch(cfg.logChannelId).catch(() => null);
    if (ch && ch.type === ChannelType.GuildText) return ch;
  }

  let existing = guild.channels.cache.find(c => c.name === 'tdr-log' && c.type === ChannelType.GuildText);
  if (!existing && fallbackToCreate) {
    existing = await guild.channels.create({
      name: 'tdr-log',
      type: ChannelType.GuildText,
      reason: 'TDR Log Kanalı'
    }).catch(() => null);
  }
  return existing;
}

// Audit logdan son işlemi yapan kişiyi bulma yardımcısı
async function findAuditExecutor(guild, auditType, targetId = null) {
  try {
    const logs = await guild.fetchAuditLogs({ limit: 6, type: auditType });
    const now = Date.now();
    const entry = logs.entries.find(e => {
      const recent = now - e.createdTimestamp < 10000;
      if (!recent) return false;
      if (targetId && e.target?.id) return e.target.id === targetId;
      return true;
    });
    return entry?.executor || null;
  } catch {
    return null;
  }
}

// Blacklist kanalını bul veya oluştur
async function getOrCreateBlacklistChannel(guild) {
  let channel = guild.channels.cache.find(c => c.name === 'tdr-blacklist' && c.type === ChannelType.GuildText);
  if (!channel) {
    channel = await guild.channels.create({
      name: 'tdr-blacklist',
      type: ChannelType.GuildText,
      reason: 'TDR Blacklist Kayıt Kanalı'
    });
  }
  return channel;
}

function buildBlacklistListEmbed(list) {
  const embed = new EmbedBuilder()
    .setTitle('TDR | BLACKLIST KAYIT LİSTESİ')
    .setColor(0x990000)
    .setTimestamp();

  if (!list.length) {
    embed.setDescription('Şu anda blacklist kaydında bulunan personel/kişi yoktur.');
    return embed;
  }

  const lines = list.map((entry, idx) =>
    `**${idx + 1}.** Roblox İsim: **${entry.robloxName}** | Roblox ID: \`${entry.robloxId}\` | Discord: **${entry.discordName}**` +
    (entry.reason ? `\n> Sebep: ${entry.reason}` : '')
  );

  embed.setDescription(lines.join('\n\n').slice(0, 4000));
  embed.setFooter({ text: `Toplam Kayıt: ${list.length}` });
  return embed;
}

async function refreshBlacklistChannelMessage(guild) {
  const channel = await getOrCreateBlacklistChannel(guild);
  const list = loadBlacklist();
  const embed = buildBlacklistListEmbed(list);

  const messages = await channel.messages.fetch({ limit: 20 });
  const botListMsg = messages.find(
    m => m.author.id === client.user.id && m.embeds[0]?.title === 'TDR | BLACKLIST KAYIT LİSTESİ'
  );

  if (botListMsg) {
    await botListMsg.edit({ embeds: [embed] });
  } else {
    await channel.send({ embeds: [embed] });
  }
}

// Roblox API Sorgu Fonksiyonu
async function fetchRobloxFullInfo(username) {
  const userLookupRes = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: false
    })
  });

  if (!userLookupRes.ok) {
    throw new Error('Roblox kullanıcı arama servisine ulaşılamadı.');
  }

  const userLookupData = await userLookupRes.json();
  if (!userLookupData.data || userLookupData.data.length === 0) {
    return null;
  }

  const basicUser = userLookupData.data[0];
  const userId = basicUser.id;

  const detailRes = await fetch(`https://users.roblox.com/v1/users/${userId}`);
  const detailData = detailRes.ok ? await detailRes.json() : {};

  const groupsRes = await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`);
  const groupsData = groupsRes.ok ? await groupsRes.json() : { data: [] };

  const thumbRes = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
  );
  const thumbData = thumbRes.ok ? await thumbRes.json() : { data: [] };
  const avatarUrl = thumbData.data?.[0]?.imageUrl || null;

  const createdAt = detailData.created ? new Date(detailData.created) : null;
  const ageDays = createdAt
    ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const groups = (groupsData.data || []).map(g => ({
    id: g.group?.id,
    name: g.group?.name || 'Bilinmeyen Grup',
    role: g.role?.name || 'Üye',
    rank: g.role?.rank ?? 0
  }));

  return {
    id: userId,
    username: detailData.name || basicUser.name,
    displayName: detailData.displayName || basicUser.displayName,
    isBanned: Boolean(detailData.isBanned),
    createdAt,
    ageDays,
    groups,
    avatarUrl
  };
}

client.once('ready', () => {
  console.log(`Bot aktif olarak giriş yaptı: ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "TRA'ya hizmet ediyorum!", type: ActivityType.Custom }],
    status: 'online'
  });
});

// --- SUNUCUYA YENİ ÜYE KATILIMI ---
client.on('guildMemberAdd', async (member) => {
  const chatChannel = getChatChannel(member.guild);
  if (chatChannel) {
    await chatChannel.send(
      `${member.user.username} sunucuya katıldı sayesinde ${member.guild.memberCount} üye olduk!`
    ).catch(() => {});
  }
});

// --- BAN LOG ---
client.on('guildBanAdd', async (ban) => {
  const logChannel = await getLogChannel(ban.guild);
  if (!logChannel) return;
  const executor = await findAuditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  const bannerName = executor ? executor.tag : 'Bilinmiyor';
  const bannedName = ban.user.tag;
  await logChannel.send(`Biri banlandı ${bannerName} ${bannedName}`).catch(() => {});
});

// --- KICK LOG ---
client.on('guildMemberRemove', async (member) => {
  const logChannel = await getLogChannel(member.guild);
  if (!logChannel) return;

  const logs = await member.guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.MemberKick }).catch(() => null);
  const now = Date.now();
  const kickEntry = logs?.entries.find(
    e => e.target?.id === member.id && now - e.createdTimestamp < 6000
  );

  if (kickEntry) {
    const kickerName = kickEntry.executor ? kickEntry.executor.tag : 'Bilinmiyor';
    const kickedName = member.user.tag;
    await logChannel.send(`Biri atıldı ${kickerName} ${kickedName}`).catch(() => {});
  }
});

// --- KANAL SİLME LOG ---
client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  const logChannel = await getLogChannel(channel.guild);
  if (!logChannel) return;

  const executor = await findAuditExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
  const deleterName = executor ? executor.tag : 'Bilinmiyor';
  await logChannel.send(`Kanal silindi ${deleterName} ${channel.name}`).catch(() => {});
});

// --- KANAL EKLEME LOG ---
client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  const logChannel = await getLogChannel(channel.guild);
  if (!logChannel) return;

  const executor = await findAuditExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
  const creatorName = executor ? executor.tag : 'Bilinmiyor';
  await logChannel.send(`Kanal eklendi ${creatorName} ${channel.name}`).catch(() => {});
});

// --- ROL VERME / ROL ALMA & MUTE LOG ---
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const logChannel = await getLogChannel(newMember.guild);
  if (!logChannel) return;

  // Rol verme / alma kontrolü
  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));

  if (addedRoles.size > 0 || removedRoles.size > 0) {
    const executor = await findAuditExecutor(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
    const actorName = executor ? executor.tag : 'Bilinmiyor';

    for (const [, role] of addedRoles) {
      await logChannel.send(`Rol verildi ${actorName} ${newMember.user.tag} - ${role.name}`).catch(() => {});
    }
    for (const [, role] of removedRoles) {
      await logChannel.send(`Rol alındı ${actorName} ${newMember.user.tag} - ${role.name}`).catch(() => {});
    }
  }

  // Mute (Timeout) kontrolü
  const oldMuted = oldMember.communicationDisabledUntilTimestamp && oldMember.communicationDisabledUntilTimestamp > Date.now();
  const newMuted = newMember.communicationDisabledUntilTimestamp && newMember.communicationDisabledUntilTimestamp > Date.now();

  if (!oldMuted && newMuted) {
    const executor = await findAuditExecutor(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
    const muterName = executor ? executor.tag : 'Bilinmiyor';
    await logChannel.send(`Biri susturuldu ${muterName} ${newMember.user.tag}`).catch(() => {});
  }
});

// --- MESAJ VE KOMUT İŞLEYİCİ ---
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const trimmed = message.content.trim();
  if (trimmed === 'sa' || trimmed === 'Sa') {
    await message.reply('aleyküm selam hoşgeldin reis');
    return;
  }

  const contentLower = message.content.toLowerCase();
  const isStaff =
    message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
    message.member?.permissions.has(PermissionsBitField.Flags.Administrator);

  // --- GÜVENLİK KONTROLLERİ (Küfür, Link, Spam) ---
  if (!isStaff) {
    const hasBadWord = BAD_WORDS.some(word => {
      const regex = new RegExp(`(^|\\s|[^a-zA-ZğüşıöçĞÜŞİÖÇ])${word}($|\\s|[^a-zA-ZğüşıöçĞÜŞİÖÇ])`, 'i');
      return regex.test(contentLower);
    });

    if (hasBadWord) {
      const deletedContent = message.content;
      await message.delete().catch(() => {});
      const warnMsg = await message.channel.send(`${message.author}, sunucuda küfür/argo kullanımı yasaktır.`);
      setTimeout(() => warnMsg.delete().catch(() => {}), 5000);

      const logChannel = await getLogChannel(message.guild);
      if (logChannel) {
        await logChannel.send(
          `Küfür engellendi ve mesaj silindi ${message.author.tag} | Silinen mesaj: ${deletedContent.slice(0, 1000)}`
        ).catch(() => {});
      }
      return;
    }

    if (LINK_REGEX.test(message.content)) {
      await message.delete().catch(() => {});
      const warnMsg = await message.channel.send(`${message.author}, izinsiz bağlantı/davet paylaşımı engellendi.`);
      setTimeout(() => warnMsg.delete().catch(() => {}), 5000);

      const logChannel = await getLogChannel(message.guild);
      if (logChannel) {
        await logChannel.send(
          `Link/reklam engellendi ve mesaj silindi ${message.author.tag} | İçerik: ${message.content.slice(0, 1000)}`
        ).catch(() => {});
      }
      return;
    }

    const now = Date.now();
    const timestamps = spamMap.get(message.author.id) || [];
    const recent = timestamps.filter(t => now - t < 5000);
    recent.push(now);
    spamMap.set(message.author.id, recent);

    if (recent.length >= 6) {
      spamMap.delete(message.author.id);
      if (message.member?.moderatable) {
        await message.member.timeout(5 * 60 * 1000, 'Anti-Spam Koruması').catch(() => {});
      }
      await message.channel.send(`${message.author}, spam yaptığı için 5 dakika susturuldu.`).catch(() => {});

      const logChannel = await getLogChannel(message.guild);
      if (logChannel) {
        await logChannel.send(`Biri susturuldu Anti-Spam ${message.author.tag}`).catch(() => {});
      }
      return;
    }
  }

  // --- KOMUT İŞLEYİCİ (T! / t!) ---
  if (!message.content.toUpperCase().startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (args.shift() || '').toLowerCase();

  // --- YARDIM ---
  if (command === 'yardim' || command === 'help' || command === 'yarıdm') {
    const embed = new EmbedBuilder()
      .setTitle('TDR / TRA | KOMUT VE GÜVENLİK LİSTESİ')
      .setColor(0x2b2d31)
      .addFields(
        {
          name: 'Roblox Sorgu',
          value: `\`${PREFIX}sorgu <roblox_isim>\` — Hesap yaşı, gruplar ve grup rolleri`
        },
        {
          name: 'Moderasyon',
          value:
            `\`${PREFIX}ban @kullanıcı [sebep]\`\n` +
            `\`${PREFIX}kick @kullanıcı [sebep]\`\n` +
            `\`${PREFIX}mute @kullanıcı <süre_dk> [sebep]\``
        },
        {
          name: 'Yönetim ve Log',
          value:
            `\`${PREFIX}log_setup\` — Log kanalını bu kanal olarak ayarlar\n` +
            `\`${PREFIX}blacklist_setup\` — Butonlu Blacklist panelini kurar (Ordu Yönetimi)`
        },
        {
          name: 'Eğlence',
          value: `\`${PREFIX}zar\`, \`${PREFIX}espri\`, \`${PREFIX}selam\``
        },
        {
          name: 'Aktif Security Korumaları',
          value: 'Küfür/argo engeli ve silme logu, izinsiz link/davet engeli, spam koruması ve otomatik timeout'
        }
      );
    return message.reply({ embeds: [embed] });
  }

  // --- LOG SETUP ---
  if (command === 'log_setup') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator) && !hasOrduYonetimi(message.member)) {
      return message.reply('Bu komutu kullanmak için **Yönetici** veya **Ordu Yönetimi** yetkisine sahip olmalısınız.');
    }

    const cfg = loadConfig();
    cfg.logChannelId = message.channel.id;
    saveConfig(cfg);

    return message.reply(`Log kanalı ${message.channel} olarak ayarlandı. Ban, kick, mute, kanal ekleme/silme, küfür engel ve rol işlemleri buradan takip edilecektir.`);
  }

  // --- BAN ---
  if (command === 'ban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return message.reply('Bu komutu kullanmak için **Üyeleri Yasakla** yetkisine sahip olmalısınız.');
    }
    const target = message.mentions.members.first();
    if (!target) return message.reply(`Kullanım: \`${PREFIX}ban @kullanıcı [sebep]\``);
    if (!target.bannable) return message.reply('Bu kullanıcı yasaklanamıyor.');

    const reason = args.slice(1).join(' ') || 'Sebep belirtilmedi.';
    await target.ban({ reason });
    await message.reply(`**${target.user.tag}** sunucudan yasaklandı. Sebep: ${reason}`);
    return;
  }

  // --- KICK ---
  if (command === 'kick') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      return message.reply('Bu komutu kullanmak için **Üyeleri At** yetkisine sahip olmalısınız.');
    }
    const target = message.mentions.members.first();
    if (!target) return message.reply(`Kullanım: \`${PREFIX}kick @kullanıcı [sebep]\``);
    if (!target.kickable) return message.reply('Bu kullanıcı atılamıyor.');

    const reason = args.slice(1).join(' ') || 'Sebep belirtilmedi.';
    await target.kick(reason);
    await message.reply(`**${target.user.tag}** sunucudan atıldı. Sebep: ${reason}`);
    return;
  }

  // --- MUTE ---
  if (command === 'mute') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      return message.reply('Bu komutu kullanmak için **Üyelere Zaman Aşımı Uygula** yetkisine sahip olmalısınız.');
    }
    const target = message.mentions.members.first();
    const minutes = parseInt(args[1], 10);
    if (!target || isNaN(minutes) || minutes <= 0 || minutes > 40320) {
      return message.reply(`Kullanım: \`${PREFIX}mute @kullanıcı <dakika (1-40320)> [sebep]\``);
    }
    if (!target.moderatable) return message.reply('Bu kullanıcı susturulamıyor.');

    const reason = args.slice(2).join(' ') || 'Sebep belirtilmedi.';
    await target.timeout(minutes * 60 * 1000, reason);
    await message.reply(`**${target.user.tag}** **${minutes} dakika** susturuldu. Sebep: ${reason}`);
    return;
  }

  // --- EĞLENCE KOMUTLARI ---
  if (command === 'zar') {
    const roll = Math.floor(Math.random() * 6) + 1;
    return message.reply(`Zar atıldı: **${roll}**`);
  }

  if (command === 'espri') {
    const jokes = [
      'Askeri disiplin: Saat 06:00 kalkış, 06:01 uykunun gözü yaşlı.',
      'Komutan "Hazır ol!" dedi, kahve makinesi bile hizaya geçti.',
      'İçtima alınırken en hızlı kim gelir? Tabii ki kantin sırasından kaçanlar.'
    ];
    const pick = jokes[Math.floor(Math.random() * jokes.length)];
    return message.reply(pick);
  }

  if (command === 'selam') {
    return message.reply(`Selam ${message.author}. TDR / TRA sistemleri aktif.`);
  }

  // --- GERÇEK ROBLOX SORGU ---
  if (command === 'sorgu') {
    const targetUsername = args[0];
    if (!targetUsername) {
      return message.reply(`Kullanım: \`${PREFIX}sorgu <roblox_kullanici_adi>\``);
    }

    const statusMsg = await message.reply(`\`${targetUsername}\` için Roblox verileri sorgulanıyor...`);

    try {
      const info = await fetchRobloxFullInfo(targetUsername);
      if (!info) {
        return statusMsg.edit(`\`${targetUsername}\` adına kayıtlı bir Roblox hesabı bulunamadı.`);
      }

      const createdStr = info.createdAt
        ? `${info.createdAt.toLocaleDateString('tr-TR')} (${info.ageDays} gün)`
        : 'Bilinmiyor';

      const groupsText = info.groups.length
        ? info.groups
            .slice(0, 15)
            .map(g => `• **${g.name}** — Rol: \`${g.role}\``)
            .join('\n')
        : 'Bulunduğu grup yok.';

      const embed = new EmbedBuilder()
        .setTitle(`ROBLOX HESAP SORGUSU | ${info.username}`)
        .setColor(0x1f6feb)
        .setThumbnail(info.avatarUrl)
        .addFields(
          { name: 'Kullanıcı Adı', value: info.username, inline: true },
          { name: 'Görünen Ad', value: info.displayName, inline: true },
          { name: 'Roblox ID', value: `\`${info.id}\``, inline: true },
          { name: 'Hesap Yaşı', value: createdStr, inline: true },
          { name: 'Grup Sayısı', value: `${info.groups.length}`, inline: true },
          { name: 'Ban Durumu', value: info.isBanned ? 'Banlı' : 'Aktif', inline: true },
          {
            name: `Gruplar ve Roller${info.groups.length > 15 ? ' (İlk 15)' : ''}`,
            value: groupsText.slice(0, 1024)
          }
        )
        .setTimestamp();

      await statusMsg.edit({ content: null, embeds: [embed] });
    } catch (err) {
      console.error('Sorgu hatası:', err);
      await statusMsg.edit('Roblox API sorgusu sırasında bir hata oluştu.');
    }
    return;
  }

  // --- BLACKLIST SETUP ---
  if (command === 'blacklist_setup') {
    if (!hasOrduYonetimi(message.member)) {
      return message.reply(`Bu komutu yalnızca **${ORDU_YONETIMI_ROL_ADI}** rolüne sahip kişiler kullanabilir.`);
    }

    await refreshBlacklistChannelMessage(message.guild);

    const embed = new EmbedBuilder()
      .setTitle('TDR | BLACKLIST YÖNETİM PANELİ')
      .setDescription(
        `Bu panel yalnızca **${ORDU_YONETIMI_ROL_ADI}** rolü içindir.\n` +
        `• **Blacklist Ekle:** İsim, Roblox ID, Discord İsim ve Sebep girerek kayıt ekler.\n` +
        `• **Blacklist Çıkar:** Kayıtlı kişiyi listeden kaldırır.`
      )
      .setColor(0x111214);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('bl_open_add_modal')
        .setLabel('Blacklist Ekle')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('bl_open_remove_menu')
        .setLabel('Blacklist Çıkar')
        .setStyle(ButtonStyle.Secondary)
    );

    await message.channel.send({ embeds: [embed], components: [row] });
    return;
  }
});

// --- BUTON, MODAL VE SEÇİM MENÜSÜ İŞLEYİCİSİ ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild) return;

  if (
    interaction.isButton() &&
    (interaction.customId === 'bl_open_add_modal' || interaction.customId === 'bl_open_remove_menu')
  ) {
    if (!hasOrduYonetimi(interaction.member)) {
      return interaction.reply({
        content: `Bu işlemi yalnızca **${ORDU_YONETIMI_ROL_ADI}** rolüne sahip kişiler yapabilir.`,
        ephemeral: true
      });
    }

    if (interaction.customId === 'bl_open_add_modal') {
      const modal = new ModalBuilder()
        .setCustomId('bl_add_modal_submit')
        .setTitle('TDR Blacklist Kayıt Ekle');

      const nameInput = new TextInputBuilder()
        .setCustomId('bl_roblox_name')
        .setLabel('İsim (Roblox Kullanıcı Adı)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const idInput = new TextInputBuilder()
        .setCustomId('bl_roblox_id')
        .setLabel('ID (Roblox User ID)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const discordInput = new TextInputBuilder()
        .setCustomId('bl_discord_name')
        .setLabel('Discord İsim')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const reasonInput = new TextInputBuilder()
        .setCustomId('bl_reason')
        .setLabel('Sebep (Opsiyonel)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(idInput),
        new ActionRowBuilder().addComponents(discordInput),
        new ActionRowBuilder().addComponents(reasonInput)
      );

      return interaction.showModal(modal);
    }

    if (interaction.customId === 'bl_open_remove_menu') {
      const list = loadBlacklist();
      if (!list.length) {
        return interaction.reply({
          content: 'Şu anda blacklist listesinde çıkarılacak kayıt bulunmuyor.',
          ephemeral: true
        });
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('bl_remove_select')
        .setPlaceholder('Blacklist listesinden çıkarılacak kişiyi seçin')
        .addOptions(
          list.slice(0, 25).map((entry, idx) => ({
            label: `${entry.robloxName} (${entry.discordName})`.slice(0, 100),
            description: `ID: ${entry.robloxId}`.slice(0, 100),
            value: String(idx)
          }))
        );

      const row = new ActionRowBuilder().addComponents(selectMenu);

      return interaction.reply({
        content: 'Listeden çıkarmak istediğiniz kişiyi seçin:',
        components: [row],
        ephemeral: true
      });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === 'bl_add_modal_submit') {
    if (!hasOrduYonetimi(interaction.member)) {
      return interaction.reply({
        content: `Bu işlemi yalnızca **${ORDU_YONETIMI_ROL_ADI}** rolü yapabilir.`,
        ephemeral: true
      });
    }

    const robloxName = interaction.fields.getTextInputValue('bl_roblox_name').trim();
    const robloxId = interaction.fields.getTextInputValue('bl_roblox_id').trim();
    const discordName = interaction.fields.getTextInputValue('bl_discord_name').trim();
    const reason = interaction.fields.getTextInputValue('bl_reason').trim();

    const list = loadBlacklist();
    list.push({
      robloxName,
      robloxId,
      discordName,
      reason,
      addedBy: interaction.user.tag,
      addedAt: new Date().toISOString()
    });
    saveBlacklist(list);

    await refreshBlacklistChannelMessage(interaction.guild);

    const blChannel = await getOrCreateBlacklistChannel(interaction.guild);
    return interaction.reply({
      content: `**${robloxName}** (\`${robloxId}\` / ${discordName}) blacklist listesine eklendi. Güncel liste: ${blChannel}`,
      ephemeral: true
    });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'bl_remove_select') {
    if (!hasOrduYonetimi(interaction.member)) {
      return interaction.reply({
        content: `Bu işlemi yalnızca **${ORDU_YONETIMI_ROL_ADI}** rolü yapabilir.`,
        ephemeral: true
      });
    }

    const idx = parseInt(interaction.values[0], 10);
    const list = loadBlacklist();

    if (isNaN(idx) || !list[idx]) {
      return interaction.reply({
        content: 'Seçilen kayıt bulunamadı.',
        ephemeral: true
      });
    }

    const [removed] = list.splice(idx, 1);
    saveBlacklist(list);

    await refreshBlacklistChannelMessage(interaction.guild);

    return interaction.update({
      content: `**${removed.robloxName}** (\`${removed.robloxId}\` / ${removed.discordName}) blacklist listesinden çıkarıldı.`,
      components: []
    });
  }
});

client.login(process.env.DISCORD_TOKEN);