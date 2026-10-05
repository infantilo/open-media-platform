//! Tag-Ausdrücke: `role:pt AND (layout:stereo OR layout:mono) AND NOT lang:en`.
//! Schlüsselwörter AND/OR/NOT sind nicht groß-/kleinschreibungsempfindlich, Tags
//! schon nicht (alles klein verglichen). Reine Auswahl, keine Wirkung.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagExpr {
    Tag(String),
    Not(Box<TagExpr>),
    And(Vec<TagExpr>),
    Or(Vec<TagExpr>),
}

impl TagExpr {
    pub fn parse(src: &str) -> Result<TagExpr, String> {
        let tokens = tokenize(src)?;
        if tokens.is_empty() {
            return Err("leerer Ausdruck".to_string());
        }
        let mut p = Parser { tokens, pos: 0 };
        let e = p.or()?;
        if p.pos != p.tokens.len() {
            return Err(format!("unerwartetes '{}'", p.tokens[p.pos]));
        }
        Ok(e)
    }

    pub fn matches(&self, tags: &[String]) -> bool {
        match self {
            TagExpr::Tag(t) => tags.iter().any(|x| x.eq_ignore_ascii_case(t)),
            TagExpr::Not(e) => !e.matches(tags),
            TagExpr::And(v) => v.iter().all(|e| e.matches(tags)),
            TagExpr::Or(v) => v.iter().any(|e| e.matches(tags)),
        }
    }
}

fn tokenize(src: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in src.chars() {
        match c {
            '(' | ')' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                out.push(c.to_string());
            }
            c if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c if c.is_alphanumeric() || "_.:-+/".contains(c) => cur.push(c),
            c => return Err(format!("ungültiges Zeichen '{c}'")),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

struct Parser {
    tokens: Vec<String>,
    pos: usize,
}

impl Parser {
    fn peek_kw(&self, kw: &str) -> bool {
        self.tokens.get(self.pos).is_some_and(|t| t.eq_ignore_ascii_case(kw))
    }

    fn or(&mut self) -> Result<TagExpr, String> {
        let mut parts = vec![self.and()?];
        while self.peek_kw("or") {
            self.pos += 1;
            parts.push(self.and()?);
        }
        Ok(if parts.len() == 1 { parts.remove(0) } else { TagExpr::Or(parts) })
    }

    fn and(&mut self) -> Result<TagExpr, String> {
        let mut parts = vec![self.not()?];
        while self.peek_kw("and") {
            self.pos += 1;
            parts.push(self.not()?);
        }
        Ok(if parts.len() == 1 { parts.remove(0) } else { TagExpr::And(parts) })
    }

    fn not(&mut self) -> Result<TagExpr, String> {
        if self.peek_kw("not") {
            self.pos += 1;
            return Ok(TagExpr::Not(Box::new(self.not()?)));
        }
        let Some(t) = self.tokens.get(self.pos).cloned() else {
            return Err("Ausdruck endet unerwartet".to_string());
        };
        self.pos += 1;
        if t == "(" {
            let e = self.or()?;
            if self.tokens.get(self.pos).map(String::as_str) != Some(")") {
                return Err("schließende Klammer fehlt".to_string());
            }
            self.pos += 1;
            return Ok(e);
        }
        if t == ")" || ["and", "or"].iter().any(|k| t.eq_ignore_ascii_case(k)) {
            return Err(format!("unerwartetes '{t}'"));
        }
        Ok(TagExpr::Tag(t.to_ascii_lowercase()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn and_or_not_and_parentheses() {
        let e = TagExpr::parse("role:pt AND (layout:stereo or layout:mono) and not lang:en").unwrap();
        assert!(e.matches(&tags(&["role:pt", "layout:mono"])));
        assert!(!e.matches(&tags(&["role:pt", "layout:mono", "lang:en"])));
        assert!(!e.matches(&tags(&["role:ad", "layout:stereo"])));
    }

    #[test]
    fn matching_ignores_case() {
        assert!(TagExpr::parse("Role:PT").unwrap().matches(&tags(&["role:pt"])));
    }

    #[test]
    fn errors_are_reported() {
        for bad in ["", "a AND", "(a", "a b c ) )", "a & b", "OR a"] {
            assert!(TagExpr::parse(bad).is_err(), "{bad:?} muss ein Fehler sein");
        }
    }
}
