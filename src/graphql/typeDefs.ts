export const typeDefs = `#graphql
  type Phrase {
    id: ID!
    german: String!
    spanish: String!
    words: [String!]
    tags: [String!]!
    createdAt: String!
  }

  type UserProgress {
    id: ID!
    userId: ID!
    phraseId: ID!
    phrase: Phrase
    ease: Float!
    interval: Int!
    repetitions: Int!
    nextDueDate: String!
    lastReviewed: String
  }

  type User {
    id: ID!
    email: String!
    authProvider: String!
    settings: UserSettings!
    createdAt: String!
  }

  type UserSettings {
    soundEnabled: Boolean!
    darkMode: Boolean!
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  input UserSettingsInput {
    soundEnabled: Boolean
    darkMode: Boolean
  }

  input PhraseFilter {
    tags: [String!]
    search: String
  }

  type TranslationResult {
    text: String!
    detectedSourceLanguage: String
  }

  type ReviewResult {
    success: Boolean!
    progress: UserProgress
  }

  type Query {
    # Auth queries
    me: User
    
    # Phrase queries
    phrases(filter: PhraseFilter, limit: Int, offset: Int): [Phrase!]!
    phrase(id: ID!): Phrase
    phrasesCount(filter: PhraseFilter): Int!
    
    # Due phrases for SRS (phrases that need review)
    duePhrases(userId: ID!, limit: Int): [UserProgress!]!
    
    # User queries
    user(id: ID!): User
    userByEmail(email: String!): User
    
    # Progress queries
    userProgress(userId: ID!, phraseId: ID!): UserProgress
    allProgress(userId: ID!): [UserProgress!]!
  }

  type Mutation {
    # Authentication
    register(email: String!, password: String!): AuthPayload!
    login(email: String!, password: String!): AuthPayload!
    
    # Review a phrase (SRS update)
    reviewPhrase(userId: ID!, phraseId: ID!, rating: Int!): ReviewResult!
    
    # Translation
    translate(text: String!, targetLang: String): TranslationResult!
    
    # User settings
    syncSettings(userId: ID!, settings: UserSettingsInput!): User
    
    # Phrase management
    addPhrase(german: String!, spanish: String!, tags: [String!]): Phrase!
    addBulkPhrases(rawText: String!): [Phrase!]!
  }
`;
